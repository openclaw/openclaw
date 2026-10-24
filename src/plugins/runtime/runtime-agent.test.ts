import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readWorkspaceStateSnapshot } from "../../agents/workspace-state-store.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import * as sessionEntryRead from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createGatewaySession } from "../../gateway/session-create-service.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  closeAgentWorkAdmissions,
  interruptSessionControllerEffects,
  isSessionMutationActive,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import * as workerStore from "../../state/openclaw-state-worker-store.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createRuntimeAgent } from "./runtime-agent.js";
import type { PluginRuntime } from "./types.js";

const cliSessionBinding = {
  sessionId: "claude-source",
  forceReuse: true,
  forkNextResume: true,
} satisfies NonNullable<SessionEntry["cliSessionBindings"]>[string];
const cliInitial = {
  cliBackendId: "claude-cli",
  model: "claude-opus-4-8",
  modelSelectionLocked: true,
  pluginOwnerId: "anthropic",
  cliSessionBinding,
} satisfies Create["initialEntry"];
const supervision = (fields: Record<string, string | boolean>) => ({
  codex: { supervision: fields },
});
const harnessInitial = (
  pluginExtensions?: SessionEntry["pluginExtensions"],
): Extract<NonNullable<Create["initialEntry"]>, { agentHarnessId: string }> => ({
  agentHarnessId: "codex",
  modelSelectionLocked: true,
  ...(pluginExtensions ? { pluginExtensions } : {}),
});
type Create = Parameters<PluginRuntime["agent"]["session"]["createSessionEntry"]>[0];
type CreateOptions<T extends Create = Create> = T extends Create
  ? Omit<T, "cfg" | "key" | "initialEntry"> & { initialEntry?: T["initialEntry"] }
  : never;
function sessionFixture(key: string) {
  const runtime = createRuntimeAgent();
  const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
  return {
    runtime,
    key,
    storePath,
    read: (latest = true) =>
      runtime.session.getSessionEntry({
        sessionKey: key,
        ...(latest ? { readConsistency: "latest" as const } : {}),
      }),
    create: (options: CreateOptions = {}) =>
      runtime.session.createSessionEntry({
        cfg: {},
        key,
        initialEntry: harnessInitial(),
        ...options,
      }),
    seed: (entry: SessionEntry) =>
      runtime.session.upsertSessionEntry({ storePath, sessionKey: key, entry }),
  };
}

function withSessionFixture(
  key: string,
  run: (
    fixture: ReturnType<typeof sessionFixture> & {
      state: Awaited<ReturnType<typeof createOpenClawTestState>>;
    },
  ) => Promise<void>,
) {
  return withOpenClawTestState({ label: "plugin-runtime-session" }, (state) =>
    run({ ...sessionFixture(key), state }),
  );
}

describe("plugin runtime session creation", () => {
  it("skips routed catalog targets denied by agent model policy", () => {
    const runtime = createRuntimeAgent();
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-8" },
          models: {
            "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
          },
          modelPolicy: { allow: ["anthropic/claude-opus-4-8"] },
        },
      },
    };

    expect(
      runtime.resolveSessionCatalogCreateTarget({
        config,
        provider: "anthropic",
        modelIds: ["unrouted-model", "claude-opus-5", "claude-opus-4-8"],
        agentRuntime: "claude-cli",
      }),
    ).toEqual({
      model: "anthropic/claude-opus-4-8",
      agentRuntime: "claude-cli",
    });
  });

  it("creates a canonical transcript with trusted initial session state", async () => {
    await withSessionFixture(
      "agent:main:harness:codex:supervision:codex-native-thread",
      async ({ key, read, create }) => {
        const initialPluginExtensions = supervision({ initializing: true, modelLocked: true });
        const finalPluginExtensions = supervision({
          nativeThreadId: "thread-native-1",
          modelLocked: true,
        });
        let callbackSessionId: string | undefined;

        const created = await create({
          label: "Native Codex thread",
          displayName: "  Native display title  ",
          initialEntry: harnessInitial(initialPluginExtensions),
          afterCreate: async (initialized) => {
            callbackSessionId = initialized.sessionId;
            expect(initialized.entry.initializationPending).toBe(true);
            expect(initialized.entry.displayName).toBe("Native display title");
            expect(read(false)?.displayName).toBe("Native display title");
            initialized.entry.displayName = "Callback clone cannot rename the session";
            return { pluginExtensions: finalPluginExtensions };
          },
        });
        initialPluginExtensions.codex.supervision.initializing = false;
        finalPluginExtensions.codex.supervision.nativeThreadId = "mutated-after-create";

        expect(callbackSessionId).toBe(created.sessionId);
        expect(created.entry.initializationPending).toBeUndefined();
        expect(created).toMatchObject({
          key,
          agentId: "main",
          sessionId: created.entry.sessionId,
          entry: {
            agentHarnessId: "codex",
            delivery: { kind: "none" },
            modelSelectionLocked: true,
            label: "Native Codex thread",
            displayName: "Native display title",
            pluginExtensions: supervision({ nativeThreadId: "thread-native-1", modelLocked: true }),
          },
        });
        const stored = read();
        expect(stored).toEqual(created.entry);
        await expect(
          create({
            initialEntry: { agentHarnessId: "other" },
          }),
        ).rejects.toThrow("Session key namespace is reserved for agent harness-owned sessions.");
        await expect(
          create({
            displayName: "Do not replace the stored title",
            initialEntry: { agentHarnessId: "codex" },
          }),
        ).rejects.toThrow("trusted initial session state requires a new session");
        expect(read()).toEqual(created.entry);
      },
    );
  });

  it("rolls back a plugin-owned locked CLI session when initialization fails", async () => {
    await withSessionFixture(
      "agent:main:catalog-adopt:claude:rollback",
      async ({ key, storePath, read, create }) => {
        let sessionId: string | undefined;

        await expect(
          create({
            initialEntry: cliInitial,
            afterCreate: async (created) => {
              sessionId = created.sessionId;
              throw new Error("history import failed");
            },
          }),
        ).rejects.toThrow("history import failed");

        expect(read()).toBeUndefined();
        await expect(
          loadTranscriptEvents({
            agentId: "main",
            sessionId: sessionId ?? "",
            sessionKey: key,
            storePath,
          }),
        ).resolves.toEqual([]);
      },
    );
  });

  it("does not run initialization when the durable initial row cannot be written", async () => {
    await withSessionFixture(
      "agent:main:dashboard:codex-initial-write-failure",
      async ({ create, state }) => {
        fs.mkdirSync(path.join(state.agentDir(), "openclaw-agent.sqlite"), { recursive: true });
        let initializerRan = false;

        await expect(
          create({
            initialEntry: {
              agentHarnessId: "codex",
              pluginExtensions: supervision({ initializing: true }),
            },
            afterCreate: async () => {
              initializerRan = true;
              return { pluginExtensions: {} };
            },
          }),
        ).rejects.toThrow();

        expect(initializerRan).toBe(false);
      },
    );
  });

  it("rolls back the original entry and transcript when final patch persistence fails", async () => {
    await withSessionFixture(
      "agent:main:dashboard:codex-final-patch-failure",
      async ({ read, create }) => {
        await expect(
          create({
            initialEntry: harnessInitial(supervision({ initializing: true })),
            afterCreate: async () => {
              return {
                pluginExtensions: {
                  codex: { supervision: { invalidJsonValue: 1n as never } },
                },
              };
            },
          }),
        ).rejects.toThrow();

        expect(read()).toBeUndefined();
      },
    );
  });

  it("fences work admission until trusted initialization completes", async () => {
    await withSessionFixture(
      "agent:main:dashboard:codex-binding-fence",
      async ({ runtime, key, storePath, read, create }) => {
        setRuntimeConfigSnapshot({});
        const callbackStarted = createDeferred();
        const releaseCallback = createDeferred();
        const creation = create({
          initialEntry: harnessInitial(supervision({ initializing: true })),
          afterCreate: async () => {
            callbackStarted.resolve();
            await releaseCallback.promise;
            return {
              pluginExtensions: supervision({ modelLocked: true }),
            };
          },
        });
        await callbackStarted.promise;
        expect(isSessionMutationActive(storePath, [key])).toBe(true);
        expect(read()).toMatchObject({
          initializationPending: true,
          pluginExtensions: supervision({ initializing: true }),
        });

        let workRan = false;
        const work = runtime.session.runWithWorkAdmission(
          { storePath, sessionKey: key },
          async () => {
            workRan = true;
          },
        );
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(workRan).toBe(false);

        releaseCallback.resolve();
        const created = await creation;
        await work;
        expect(workRan).toBe(true);
        expect(isSessionMutationActive(storePath, [key])).toBe(false);
        expect(created.entry.pluginExtensions).toEqual(supervision({ modelLocked: true }));
        expect(created.entry.initializationPending).toBeUndefined();
        expect(read()).toEqual(created.entry);
      },
    );
  });

  it("rejects an ordinary same-key create while trusted initialization is pending", async () => {
    await withSessionFixture(
      "agent:main:dashboard:codex-initialization-race",
      async ({ key, read, create }) => {
        const callbackStarted = createDeferred();
        const releaseCallback = createDeferred();
        const creation = create({
          label: "Trusted initializer",
          initialEntry: {
            agentHarnessId: "codex",
            pluginExtensions: supervision({ initializing: true }),
          },
          afterCreate: async () => {
            callbackStarted.resolve();
            await releaseCallback.promise;
            return {
              pluginExtensions: supervision({ modelLocked: true }),
            };
          },
        });
        await callbackStarted.promise;

        const raced = await createGatewaySession({
          cfg: {},
          key,
          label: "Public overwrite",
          commandSource: "test",
        });

        expect(raced).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("is still initializing") },
        });
        expect(read()).toMatchObject({
          initializationPending: true,
          label: "Trusted initializer",
          pluginExtensions: supervision({ initializing: true }),
        });

        releaseCallback.resolve();
        const created = await creation;
        expect(created.entry.initializationPending).toBeUndefined();
        expect(created.entry).toMatchObject({
          label: "Trusted initializer",
          pluginExtensions: supervision({ modelLocked: true }),
        });
      },
    );
  });

  it("rejects creation while pre-existing session work is admitted", async () => {
    await withSessionFixture(
      "agent:main:dashboard:codex-binding-active",
      async ({ runtime, key, storePath, read, create }) => {
        setRuntimeConfigSnapshot({});
        const workStarted = createDeferred();
        const releaseWork = createDeferred();
        const work = runtime.session.runWithWorkAdmission(
          { storePath, sessionKey: key },
          async () => {
            workStarted.resolve();
            await releaseWork.promise;
          },
        );
        await workStarted.promise;

        await expect(
          create({
            initialEntry: harnessInitial(),
          }),
        ).rejects.toThrow(`Session "${key}" is still active; retry creation later.`);
        expect(read()).toBe(undefined);

        releaseWork.resolve();
        await work;
      },
    );
  });

  it("recovers an exact initializer without replacing its label or title", async () => {
    const naming = { label: "Operator label", displayName: "Original title snapshot" };
    await withSessionFixture(
      "agent:main:dashboard:codex-recovery",
      async ({ runtime, key, storePath, read, create, state }) => {
        const sessionId = "interrupted-initializer";
        const sessionFile = path.join(state.sessionsDir(), `${sessionId}.jsonl`);
        const initialPluginExtensions = supervision({
          sourceThreadId: "source-1",
          initializing: true,
        });
        const persistedPluginExtensions = supervision({
          initializing: true,
          sourceThreadId: "source-1",
        });
        fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
        fs.writeFileSync(
          sessionFile,
          `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`,
        );
        await runtime.session.upsertSessionEntry({
          storePath,
          sessionKey: key,
          entry: {
            ...naming,
            sessionId,
            sessionFile,
            updatedAt: Date.now(),
            initializationPending: true,
            agentHarnessId: "codex",
            modelSelectionLocked: true,
            pluginExtensions: persistedPluginExtensions,
            spawnedCwd: "/workspace/project",
            sessionRoot: "/workspace",
            permissionMode: "guarded",
          },
        });

        const recovered = await create({
          label: "Replacement label must be ignored",
          displayName: "Renamed upstream title must be ignored",
          spawnedCwd: "/workspace/project",
          sessionRoot: "/workspace",
          permissionMode: "guarded",
          recoverMatchingInitialEntry: true,
          initialEntry: harnessInitial(initialPluginExtensions),
          afterCreate: async (created) => {
            expect(created.sessionId).toBe(sessionId);
            expect(created.entry.initializationPending).toBe(true);
            return {
              pluginExtensions: supervision({ sourceThreadId: "source-1", modelLocked: true }),
            };
          },
        });

        expect(recovered.sessionId).toBe(sessionId);
        expect(recovered.entry.label).toBe(naming.label);
        expect(recovered.entry.displayName).toBe(naming.displayName);
        expect(recovered.entry.initializationPending).toBeUndefined();
        expect(recovered.entry.pluginExtensions).toEqual(
          supervision({ sourceThreadId: "source-1", modelLocked: true }),
        );
        expect(read()).toEqual(recovered.entry);
      },
    );
  });

  it.each([
    {
      name: "spawned workspace",
      spawnedCwd: "/workspace/other",
      requestedCwd: "/workspace/project",
      sourceThreadId: "source-1",
    },
    {
      name: "trusted ownership",
      spawnedCwd: undefined,
      requestedCwd: undefined,
      sourceThreadId: "different-source",
    },
  ])(
    "does not recover an initializer with different $name",
    async ({ spawnedCwd, requestedCwd, sourceThreadId }) => {
      await withSessionFixture(
        "agent:main:dashboard:codex-recovery-mismatch",
        async ({ read, create, seed }) => {
          const existing: SessionEntry = {
            sessionId: "foreign-initializer",
            updatedAt: Date.now(),
            delivery: { kind: "none" },
            initializationPending: true,
            ...harnessInitial(supervision({ sourceThreadId, initializing: true })),
            ...(spawnedCwd ? { spawnedCwd } : {}),
          };
          await seed(existing);
          await expect(
            create({
              ...(requestedCwd ? { spawnedCwd: requestedCwd } : {}),
              recoverMatchingInitialEntry: true,
              initialEntry: harnessInitial(
                supervision({ sourceThreadId: "source-1", initializing: true }),
              ),
              afterCreate: async () => ({ pluginExtensions: {} }),
            }),
          ).rejects.toThrow("does not match its trusted recovery state");
          expect(read()).toEqual(existing);
        },
      );
    },
  );

  it("does not recover or roll back a locked CLI row owned by another plugin", async () => {
    await withSessionFixture(
      "agent:main:catalog-adopt:claude:foreign",
      async ({ read, create, seed }) => {
        const existing = {
          sessionId: "foreign-initializer",
          updatedAt: Date.now(),
          delivery: { kind: "none" as const },
          initializationPending: true as const,
          modelSelectionLocked: true,
          pluginOwnerId: "other-plugin",
          providerOverride: "claude-cli",
          modelOverride: "claude-opus-4-8",
          cliSessionBindings: { "claude-cli": cliSessionBinding },
        };
        await seed(existing);

        await expect(
          create({
            recoverMatchingInitialEntry: true,
            initialEntry: cliInitial,
            afterCreate: async () => {
              throw new Error("must not run");
            },
          }),
        ).rejects.toThrow("does not match its trusted recovery state");
        expect(read()).toEqual(existing);
      },
    );
  });

  it("rejects work for a persisted initializer without an active process fence", async () => {
    await withSessionFixture(
      "agent:main:dashboard:codex-restart-pending",
      async ({ runtime, key, storePath }) => {
        setRuntimeConfigSnapshot({});
        await runtime.session.upsertSessionEntry({
          storePath,
          sessionKey: key,
          entry: {
            sessionId: "interrupted-initializer",
            updatedAt: Date.now(),
            initializationPending: true,
          },
        });
        expect(isSessionMutationActive(storePath, [key])).toBe(false);
        let workRan = false;

        await expect(
          runtime.session.runWithWorkAdmission({ storePath, sessionKey: key }, async () => {
            workRan = true;
          }),
        ).rejects.toThrow("is still initializing");
        expect(workRan).toBe(false);
      },
    );
  });

  it("preserves a concurrent title change before finalization", async () => {
    await withSessionFixture(
      "agent:main:dashboard:codex-binding-race",
      async ({ runtime, read, create }) => {
        setRuntimeConfigSnapshot({});
        let sessionId: string | undefined;

        await expect(
          create({
            initialEntry: harnessInitial(),
            afterCreate: async (created) => {
              sessionId = created.sessionId;
              await runtime.session.patchSessionEntry({
                sessionKey: created.key,
                update: () => ({ displayName: "claimed concurrently" }),
              });
              return {
                pluginExtensions: supervision({ modelLocked: true }),
              };
            },
          }),
        ).rejects.toThrow("guarded rollback did not complete");

        expect(read()).toMatchObject({
          sessionId,
          displayName: "claimed concurrently",
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        });
      },
    );
  });

  it("rejects title mutation in the pluginExtensions-only final patch", async () => {
    await withSessionFixture("agent:main:dashboard:title-final-patch", async ({ read, create }) => {
      await expect(
        create({
          displayName: "Initial title",
          initialEntry: { agentHarnessId: "codex" },
          afterCreate: async () => ({ pluginExtensions: {}, displayName: "Invalid replacement" }),
        }),
      ).rejects.toThrow("session creation final patch may only contain pluginExtensions");
      expect(read(false)).toBeUndefined();
    });
  });
});

describe("plugin runtime session work admission", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-plugin-session-admission-");
  let storePath: string;
  const sessionKey = "agent:main:voice:caller";
  const sessionId = "voice-session-id";

  afterEach(clearRuntimeConfigSnapshot);
  beforeEach(async () => {
    setRuntimeConfigSnapshot({});
    const tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "sessions.json");
    await createRuntimeAgent().session.upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId, updatedAt: Date.now() },
    });
  });

  it("refuses plugin work and session creation while the agent is draining", async () => {
    const runtime = createRuntimeAgent();
    const reason = new Error("agent deletion began");
    const reopen = closeAgentWorkAdmissions({ agentId: "main", reason });
    const run = vi.fn(async () => {});
    try {
      await expect(
        runtime.session.runWithWorkAdmission({ storePath, sessionKey }, run),
      ).rejects.toBe(reason);
      await expect(
        runtime.session.createSessionEntry({
          cfg: {},
          key: "agent:main:harness:codex:draining",
          initialEntry: { agentHarnessId: "codex" },
        }),
      ).rejects.toBe(reason);
      expect(run).not.toHaveBeenCalled();
    } finally {
      reopen();
    }
  });

  it("waits for a queued archive mutation and rejects the stale start", async () => {
    const runtime = createRuntimeAgent();
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runSessionMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      prepare: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
      },
      run: async () => {
        await runtime.session.patchSessionEntry({
          storePath,
          sessionKey,
          update: () => ({ archivedAt: Date.now() }),
        });
      },
    });
    await mutationStarted.promise;

    let ran = false;
    const work = runtime.session.runWithWorkAdmission({ storePath, sessionKey }, async () => {
      ran = true;
    });
    releaseMutation.resolve();
    await mutation;

    await expect(work).rejects.toThrow(`Session "${sessionKey}" is archived`);
    expect(ran).toBe(false);
  });

  it("rejects a session replaced while work waits for lifecycle admission", async () => {
    const runtime = createRuntimeAgent();
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runSessionMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      prepare: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
      },
      run: async () => {
        await runtime.session.upsertSessionEntry({
          storePath,
          sessionKey,
          entry: { sessionId: "replacement-session", updatedAt: Date.now() },
        });
      },
    });
    await mutationStarted.promise;

    const snapshotRead = createDeferred();
    const readEntry = sessionEntryRead.withSessionEntryReadOnlyInWorker;
    using captureRead = vi
      .spyOn(sessionEntryRead, "withSessionEntryReadOnlyInWorker")
      .mockImplementationOnce((input, assertCurrent, consume, ...rest) =>
        readEntry(
          input,
          assertCurrent,
          async (...result) => {
            snapshotRead.resolve();
            return consume(...result);
          },
          ...rest,
        ),
      );
    const run = vi.fn(async () => {});
    const work = runtime.session.runWithWorkAdmission({ storePath, sessionKey }, run);
    try {
      await snapshotRead.promise;
      captureRead.mockRestore();
      releaseMutation.resolve();
      await mutation;
      await expect(work).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
      expect(run).not.toHaveBeenCalled();
    } finally {
      releaseMutation.resolve();
      await Promise.allSettled([mutation, work]);
    }
  });

  it("holds admission through the callback and relays lifecycle interruption", async () => {
    const runtime = createRuntimeAgent();
    const workStarted = createDeferred();
    let admittedSignal: AbortSignal | undefined;
    const work = runtime.session.runWithWorkAdmission({ storePath, sessionKey }, async (signal) => {
      admittedSignal = signal;
      workStarted.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    await workStarted.promise;

    await interruptSessionControllerEffects({
      scope: storePath,
      identities: [sessionKey, sessionId],
    });
    await work;

    expect(admittedSignal?.aborted).toBe(true);
  });
});

it("allows deprecated plugin SQL checks once before dispatch while typed guards retain commit authority", async () => {
  type Params = NonNullable<Parameters<PluginRuntime["agent"]["ensureAgentWorkspace"]>[0]>;
  const state = await createOpenClawTestState({ layout: "state-only" });
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const ensure = createRuntimeAgent().ensureAgentWorkspace;
  const originalOperation = workerStore.runOpenClawStateWorkerOperation;
  const originalMkdir = fsPromises.mkdir;
  let phase: string | undefined;
  let workspace: string;
  const events: string[] = [];
  probe.admission(admission, (request, grant, admit) => {
    phase = request.stage;
    try {
      admit(request, () => {
        events.push(`grant:${phase}`);
        return grant();
      });
    } finally {
      phase = undefined;
    }
  });
  vi.spyOn(workerStore, "runOpenClawStateWorkerOperation").mockImplementation(
    (context, operation, options) =>
      originalOperation(
        context,
        (scope) => {
          const execute: typeof scope.execute = (...args) => {
            events.push(`dispatch:${args[0].type}`);
            return scope.execute(...args);
          };
          return operation({ execute });
        },
        options,
      ),
  );
  vi.spyOn(fsPromises, "mkdir").mockImplementation((dir, options) => {
    if (dir === workspace) {
      events.push("file:mkdir");
    }
    return originalMkdir(dir, options);
  });
  try {
    runOpenClawStateWriteTransaction(() => undefined);
    for (const mode of [
      "initial-refusal",
      "allowed-sql",
      "legacy-refusal",
      "typed-revocation",
    ] as const) {
      workspace = state.path(mode);
      events.length = 0;
      if (mode !== "initial-refusal") {
        fs.mkdirSync(workspace);
        fs.writeFileSync(`${workspace}/AGENTS.md`, "Synthetic workspace instructions.\n");
      }
      const before = await readWorkspaceStateSnapshot(workspace, { readOnly: true });
      const refusal = new Error("plugin authority revoked");
      const params: Params = {
        dir: workspace,
        ensureBootstrapFiles: false,
        guard: {
          assertHost() {
            if (phase) {
              events.push("typed");
              if (mode === "typed-revocation" && phase === "commit") {
                throw refusal;
              }
            }
          },
        },
        beforePersistentApply() {
          expect(phase).toBeUndefined();
          const previous = events.at(-1);
          events.push("legacy");
          if (
            mode === "initial-refusal" ||
            (mode === "legacy-refusal" && previous === "file:mkdir")
          ) {
            throw refusal;
          }
          expect(
            withExistingOpenClawStateDatabaseCurrentReadOnly(({ db }) =>
              db.prepare("SELECT 1 AS value").get(),
            ),
          ).toEqual({ value: 1 });
        },
      };
      const pending = ensure(params);
      if (mode === "allowed-sql") {
        await pending;
        expect(events.filter((event) => event !== "typed" && !event.startsWith("grant:"))).toEqual([
          "legacy",
          "dispatch:workspace.snapshotAndRegister",
          "legacy",
          "file:mkdir",
          "legacy",
          "dispatch:workspace.replaceAttestation",
        ]);
        for (const [index, event] of events.entries()) {
          if (event.startsWith("grant:")) {
            expect(events[index - 1]).toBe("typed");
          }
        }
        expect(events).toContain("grant:commit");
        expect(
          (await readWorkspaceStateSnapshot(workspace, { readOnly: true })).attestation,
        ).toBeDefined();
      } else {
        await expect(pending).rejects.toBe(refusal);
        expect(await readWorkspaceStateSnapshot(workspace, { readOnly: true })).toEqual(before);
        if (mode === "initial-refusal") {
          expect(events).toEqual(["legacy"]);
          expect(fs.existsSync(workspace)).toBe(false);
        } else if (mode === "legacy-refusal") {
          expect(events.filter((event) => event.startsWith("dispatch:"))).toEqual([
            "dispatch:workspace.snapshotAndRegister",
          ]);
        }
      }
    }
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        /before dispatch.*synchronous OpenClaw DB access.*deprecated.*guard.assertHost/,
      ),
      { code: "DEP_WORKSPACE_MUTATION_GUARD", type: "DeprecationWarning" },
    );
  } finally {
    vi.restoreAllMocks();
    await state.cleanup();
  }
});
