import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, aroundEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const recoveryInitial = (sourceThreadId = "source-1") =>
  harnessInitial(supervision({ sourceThreadId, initializing: true }));

type Create = Parameters<PluginRuntime["agent"]["session"]["createSessionEntry"]>[0];
type CreateOptions<T extends Create = Create> = T extends Create
  ? Omit<T, "cfg" | "key" | "initialEntry"> & { initialEntry?: T["initialEntry"] }
  : never;
function sessionFixture(key = "agent:main:dashboard:test") {
  const runtime = createRuntimeAgent();
  const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
  const create = (options: CreateOptions = {}) =>
    runtime.session.createSessionEntry({
      cfg: {},
      key,
      initialEntry: harnessInitial(),
      ...options,
    });
  return {
    runtime,
    key,
    storePath,
    read: (latest = true) =>
      runtime.session.getSessionEntry({
        sessionKey: key,
        ...(latest ? { readConsistency: "latest" as const } : {}),
      }),
    create,
    beginInitialization: async (options: CreateOptions = {}) => {
      const started = createDeferred();
      const release = createDeferred();
      const creation = create({
        ...options,
        afterCreate: async () => {
          started.resolve();
          await release.promise;
          return { pluginExtensions: supervision({ modelLocked: true }) };
        },
      });
      await started.promise;
      return { creation, release };
    },
    seed: (entry: SessionEntry) =>
      runtime.session.upsertSessionEntry({ storePath, sessionKey: key, entry }),
  };
}

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

describe("plugin runtime session creation", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  aroundEach((runTest) =>
    withOpenClawTestState({ label: "plugin-runtime-session" }, async (current) => {
      state = current;
      setRuntimeConfigSnapshot({});
      await runTest();
    }),
  );

  it("creates and recovers a trusted harness session without changing its title", async () => {
    const { key, read, create, seed } = sessionFixture(
      "agent:main:harness:codex:supervision:codex-native-thread",
    );
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

    const location = {
      spawnedCwd: "/workspace/project",
      sessionRoot: "/workspace",
      permissionMode: "guarded",
    } satisfies Pick<Create, "spawnedCwd" | "sessionRoot" | "permissionMode">;
    const initialEntry = recoveryInitial();
    await seed({
      ...created.entry,
      ...initialEntry,
      ...location,
      pluginExtensions: supervision({ initializing: true, sourceThreadId: "source-1" }),
      initializationPending: true,
    });
    const recovered = await create({
      ...location,
      label: "Replacement label must be ignored",
      displayName: "Replacement title must be ignored",
      initialEntry,
      recoverMatchingInitialEntry: true,
      afterCreate: async (recovering) => {
        expect(recovering.sessionId).toBe(created.sessionId);
        expect(recovering.entry.initializationPending).toBe(true);
        return { pluginExtensions: supervision({ sourceThreadId: "source-1", modelLocked: true }) };
      },
    });
    expect(recovered.sessionId).toBe(created.sessionId);
    expect(recovered.entry).toMatchObject({
      ...location,
      label: "Native Codex thread",
      displayName: "Native display title",
    });
    expect(recovered.entry.initializationPending).toBeUndefined();
    expect(recovered.entry.pluginExtensions).toEqual(
      supervision({ sourceThreadId: "source-1", modelLocked: true }),
    );
    expect(read()).toEqual(recovered.entry);
  });

  it("rolls back a plugin-owned locked CLI session when initialization fails", async () => {
    const { key, storePath, read, create } = sessionFixture();
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
  });

  it("does not run initialization when the durable initial row cannot be written", async () => {
    const { create } = sessionFixture();
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
  });

  it.each(["persistence", "forbidden field"] as const)(
    "rolls back a rejected final patch: %s",
    async (failure) => {
      const { read, create } = sessionFixture();
      await expect(
        create({
          displayName: "Initial title",
          initialEntry:
            failure === "persistence"
              ? harnessInitial(supervision({ initializing: true }))
              : { agentHarnessId: "codex" },
          afterCreate: async (): Promise<{
            pluginExtensions: NonNullable<SessionEntry["pluginExtensions"]>;
            displayName?: string;
          }> =>
            failure === "persistence"
              ? { pluginExtensions: { codex: { supervision: { invalidJsonValue: 1n as never } } } }
              : { pluginExtensions: {}, displayName: "Invalid replacement" },
        }),
      ).rejects.toThrow(
        failure === "persistence"
          ? undefined
          : "session creation final patch may only contain pluginExtensions",
      );
      expect(read(failure === "persistence")).toBeUndefined();
    },
  );

  it("fences work and rejects competing creation until trusted initialization completes", async () => {
    const { runtime, key, storePath, read, beginInitialization } = sessionFixture();
    const { creation, release } = await beginInitialization({
      label: "Trusted initializer",
      initialEntry: harnessInitial(supervision({ initializing: true })),
    });
    expect(isSessionMutationActive(storePath, [key])).toBe(true);
    expect(read()).toMatchObject({
      initializationPending: true,
      pluginExtensions: supervision({ initializing: true }),
    });

    let workRan = false;
    const work = runtime.session.runWithWorkAdmission({ storePath, sessionKey: key }, async () => {
      workRan = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(workRan).toBe(false);

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

    release.resolve();
    const created = await creation;
    await work;
    expect(workRan).toBe(true);
    expect(isSessionMutationActive(storePath, [key])).toBe(false);
    expect(created.entry.label).toBe("Trusted initializer");
    expect(created.entry.pluginExtensions).toEqual(supervision({ modelLocked: true }));
    expect(created.entry.initializationPending).toBeUndefined();
    expect(read()).toEqual(created.entry);
  });

  it("rejects creation while pre-existing session work is admitted", async () => {
    const { runtime, key, storePath, read, create } = sessionFixture();
    const workStarted = createDeferred();
    const releaseWork = createDeferred();
    const work = runtime.session.runWithWorkAdmission({ storePath, sessionKey: key }, async () => {
      workStarted.resolve();
      await releaseWork.promise;
    });
    await workStarted.promise;

    await expect(
      create({
        initialEntry: harnessInitial(),
      }),
    ).rejects.toThrow(`Session "${key}" is still active; retry creation later.`);
    expect(read()).toBe(undefined);

    releaseWork.resolve();
    await work;
  });

  it.each([
    {
      name: "spawned workspace",
      stored: {
        ...recoveryInitial(),
        spawnedCwd: "/workspace/other",
      },
      requested: {
        initialEntry: recoveryInitial(),
        spawnedCwd: "/workspace/project",
      },
    },
    {
      name: "trusted ownership",
      stored: recoveryInitial("different-source"),
      requested: {
        initialEntry: recoveryInitial(),
      },
    },
    {
      name: "CLI plugin owner",
      stored: {
        modelSelectionLocked: true,
        pluginOwnerId: "other-plugin",
        providerOverride: "claude-cli",
        modelOverride: "claude-opus-4-8",
        cliSessionBindings: { "claude-cli": cliSessionBinding },
      },
      requested: { initialEntry: cliInitial },
    },
  ])(
    "does not recover or roll back an initializer with different $name",
    async ({ stored, requested }) => {
      const { read, create, seed } = sessionFixture();
      const existing: SessionEntry = {
        sessionId: "foreign-initializer",
        updatedAt: Date.now(),
        delivery: { kind: "none" },
        initializationPending: true,
        ...stored,
      };
      await seed(existing);
      await expect(
        create({
          ...requested,
          recoverMatchingInitialEntry: true,
          afterCreate: async () => {
            throw new Error("must not run");
          },
        }),
      ).rejects.toThrow("does not match its trusted recovery state");
      expect(read()).toEqual(existing);
    },
  );

  it("rejects work for a persisted initializer without an active process fence", async () => {
    const { runtime, key, storePath } = sessionFixture();
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
  });

  it("preserves a concurrent title change before finalization", async () => {
    const { runtime, read, create } = sessionFixture();
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

  async function queueMutation(run: () => Promise<void>) {
    const started = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runSessionMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      prepare: async () => {
        started.resolve();
        await releaseMutation.promise;
      },
      run,
    });
    await started.promise;
    return { mutation, releaseMutation };
  }

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

  it.each(["archive", "replace"] as const)(
    "rejects a queued %s before plugin work starts",
    async (change) => {
      const runtime = createRuntimeAgent();
      const { mutation, releaseMutation } = await queueMutation(async () => {
        if (change === "replace") {
          await runtime.session.upsertSessionEntry({
            storePath,
            sessionKey,
            entry: { sessionId: "replacement-session", updatedAt: Date.now() },
          });
        } else {
          await runtime.session.patchSessionEntry({
            storePath,
            sessionKey,
            update: () => ({ archivedAt: Date.now() }),
          });
        }
      });

      const snapshotRead = createDeferred();
      const readEntry = sessionEntryRead.withSessionEntryReadOnlyInWorker;
      using captureRead =
        change === "replace"
          ? vi
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
              )
          : undefined;
      const run = vi.fn(async () => {});
      const work = runtime.session.runWithWorkAdmission({ storePath, sessionKey }, run);
      try {
        if (change === "replace") {
          await snapshotRead.promise;
          captureRead?.mockRestore();
        }
        releaseMutation.resolve();
        await mutation;
        if (change === "replace") {
          await expect(work).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
        } else {
          await expect(work).rejects.toThrow(`Session "${sessionKey}" is archived`);
        }
        expect(run).not.toHaveBeenCalled();
      } finally {
        releaseMutation.resolve();
        await Promise.allSettled([mutation, work]);
      }
    },
  );

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

it("allows legacy SQL checks before dispatch and honors live commit revocation", async () => {
  const state = await createOpenClawTestState({ layout: "state-only" });
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const originalMkdir = fsPromises.mkdir;
  let phase: string | undefined;
  let workspace: string;
  let mkdirCalled = false;
  probe.admission(admission, (request, grant, admit) => {
    phase = request.stage;
    try {
      admit(request, grant);
    } finally {
      phase = undefined;
    }
  });
  vi.spyOn(fsPromises, "mkdir").mockImplementation((dir, options) => {
    if (dir === workspace) {
      mkdirCalled = true;
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
      mkdirCalled = false;
      if (mode !== "initial-refusal") {
        fs.mkdirSync(workspace);
        fs.writeFileSync(`${workspace}/AGENTS.md`, "Synthetic workspace instructions.\n");
      }
      const before = await readWorkspaceStateSnapshot(workspace, { readOnly: true });
      const refusal = new Error("plugin authority revoked");
      const pending = createRuntimeAgent().ensureAgentWorkspace({
        dir: workspace,
        ensureBootstrapFiles: false,
        guard: {
          assertHost() {
            if (mode === "typed-revocation" && phase === "commit") {
              throw refusal;
            }
          },
        },
        beforePersistentApply() {
          expect(phase).toBeUndefined();
          if (mode === "initial-refusal" || (mode === "legacy-refusal" && mkdirCalled)) {
            throw refusal;
          }
          expect(
            withExistingOpenClawStateDatabaseCurrentReadOnly(({ db }) =>
              db.prepare("SELECT 1 AS value").get(),
            ),
          ).toEqual({ value: 1 });
        },
      });
      if (mode === "allowed-sql") {
        await pending;
        expect(
          (await readWorkspaceStateSnapshot(workspace, { readOnly: true })).attestation,
        ).toBeDefined();
      } else {
        await expect(pending).rejects.toBe(refusal);
        expect(await readWorkspaceStateSnapshot(workspace, { readOnly: true })).toEqual(before);
        if (mode === "initial-refusal") {
          expect(fs.existsSync(workspace)).toBe(false);
        }
      }
    }
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      code: "DEP_WORKSPACE_MUTATION_GUARD",
      type: "DeprecationWarning",
    });
  } finally {
    vi.restoreAllMocks();
    await state.cleanup();
  }
});
