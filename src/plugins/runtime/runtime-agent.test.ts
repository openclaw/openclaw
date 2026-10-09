import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readWorkspaceStateSnapshot } from "../../agents/workspace-state-store.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { createGatewaySession } from "../../gateway/session-create-service.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import {
  interruptSessionWorkAdmissions,
  isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
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
    await withOpenClawTestState({ label: "plugin-runtime-session-create" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:harness:codex:supervision:codex-native-thread";
      const initialPluginExtensions = {
        codex: {
          supervision: {
            initializing: true,
            modelLocked: true,
          },
        },
      };
      const finalPluginExtensions = {
        codex: {
          supervision: {
            nativeThreadId: "thread-native-1",
            modelLocked: true,
          },
        },
      };
      let callbackSessionId: string | undefined;

      const created = await runtime.session.createSessionEntry({
        cfg: {},
        key,
        label: "Native Codex thread",
        displayName: "  Native display title  ",
        initialEntry: {
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          pluginExtensions: initialPluginExtensions,
        },
        afterCreate: async (initialized) => {
          callbackSessionId = initialized.sessionId;
          expect(initialized.entry.initializationPending).toBe(true);
          expect(initialized.entry.displayName).toBe("Native display title");
          expect(runtime.session.getSessionEntry({ sessionKey: key })?.displayName).toBe(
            "Native display title",
          );
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
          pluginExtensions: {
            codex: {
              supervision: {
                nativeThreadId: "thread-native-1",
                modelLocked: true,
              },
            },
          },
        },
      });
      const stored = runtime.session.getSessionEntry({
        sessionKey: key,
        readConsistency: "latest",
      });
      expect(stored).toEqual(created.entry);
      await expect(
        runtime.session.createSessionEntry({
          cfg: {},
          key,
          initialEntry: { agentHarnessId: "other" },
        }),
      ).rejects.toThrow("Session key namespace is reserved for agent harness-owned sessions.");
      await expect(
        runtime.session.createSessionEntry({
          cfg: {},
          key,
          displayName: "Do not replace the stored title",
          initialEntry: { agentHarnessId: "codex" },
        }),
      ).rejects.toThrow("trusted initial session state requires a new session");
      expect(
        runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
      ).toEqual(created.entry);
    });
  });

  it("rolls back a plugin-owned locked CLI session when initialization fails", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-cli-session-rollback" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:catalog-adopt:claude:rollback";
      const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
      let sessionId: string | undefined;

      await expect(
        runtime.session.createSessionEntry({
          cfg: {},
          key,
          initialEntry: {
            cliBackendId: "claude-cli",
            model: "claude-opus-4-8",
            modelSelectionLocked: true,
            pluginOwnerId: "anthropic",
            cliSessionBinding: {
              sessionId: "claude-source",
              forceReuse: true,
              forkNextResume: true,
            },
          },
          afterCreate: async (created) => {
            sessionId = created.sessionId;
            throw new Error("history import failed");
          },
        }),
      ).rejects.toThrow("history import failed");

      expect(
        runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
      ).toBeUndefined();
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          sessionId: sessionId ?? "",
          sessionKey: key,
          storePath,
        }),
      ).resolves.toEqual([]);
    });
  });

  it("does not run initialization when the durable initial row cannot be written", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-initial-write-failure" },
      async (state) => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:codex-initial-write-failure";
        fs.mkdirSync(path.join(state.agentDir(), "openclaw-agent.sqlite"), { recursive: true });
        let initializerRan = false;

        await expect(
          runtime.session.createSessionEntry({
            cfg: {},
            key,
            initialEntry: {
              agentHarnessId: "codex",
              pluginExtensions: {
                codex: { supervision: { initializing: true } },
              },
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
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-final-patch-rollback" },
      async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:codex-final-patch-failure";
        await expect(
          runtime.session.createSessionEntry({
            cfg: {},
            key,
            initialEntry: {
              agentHarnessId: "codex",
              modelSelectionLocked: true,
              pluginExtensions: {
                codex: { supervision: { initializing: true } },
              },
            },
            afterCreate: async () => {
              return {
                pluginExtensions: {
                  codex: { supervision: { invalidJsonValue: 1n as never } },
                },
              };
            },
          }),
        ).rejects.toThrow();

        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toBeUndefined();
      },
    );
  });

  it("fences work admission until trusted initialization completes", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-session-create-fence" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:dashboard:codex-binding-fence";
      const callbackStarted = createDeferred();
      const releaseCallback = createDeferred();
      const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });

      const creation = runtime.session.createSessionEntry({
        cfg: {},
        key,
        initialEntry: {
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          pluginExtensions: {
            codex: { supervision: { initializing: true } },
          },
        },
        afterCreate: async () => {
          callbackStarted.resolve();
          await releaseCallback.promise;
          return {
            pluginExtensions: {
              codex: { supervision: { modelLocked: true } },
            },
          };
        },
      });
      await callbackStarted.promise;
      expect(isSessionLifecycleMutationActive(storePath, [key])).toBe(true);
      expect(
        runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
      ).toMatchObject({
        initializationPending: true,
        pluginExtensions: {
          codex: { supervision: { initializing: true } },
        },
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
      expect(isSessionLifecycleMutationActive(storePath, [key])).toBe(false);
      expect(created.entry.pluginExtensions).toEqual({
        codex: { supervision: { modelLocked: true } },
      });
      expect(created.entry.initializationPending).toBeUndefined();
      expect(
        runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
      ).toEqual(created.entry);
    });
  });

  it("rejects an ordinary same-key create while trusted initialization is pending", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-ordinary-race" },
      async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:codex-initialization-race";
        const callbackStarted = createDeferred();
        const releaseCallback = createDeferred();
        const creation = runtime.session.createSessionEntry({
          cfg: {},
          key,
          label: "Trusted initializer",
          initialEntry: {
            agentHarnessId: "codex",
            pluginExtensions: { codex: { supervision: { initializing: true } } },
          },
          afterCreate: async () => {
            callbackStarted.resolve();
            await releaseCallback.promise;
            return {
              pluginExtensions: { codex: { supervision: { modelLocked: true } } },
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
        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toMatchObject({
          initializationPending: true,
          label: "Trusted initializer",
          pluginExtensions: { codex: { supervision: { initializing: true } } },
        });

        releaseCallback.resolve();
        const created = await creation;
        expect(created.entry.initializationPending).toBeUndefined();
        expect(created.entry).toMatchObject({
          label: "Trusted initializer",
          pluginExtensions: { codex: { supervision: { modelLocked: true } } },
        });
      },
    );
  });

  it("rejects creation while pre-existing session work is admitted", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-session-create-active" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:dashboard:codex-binding-active";
      const workStarted = createDeferred();
      const releaseWork = createDeferred();
      const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
      const work = runtime.session.runWithWorkAdmission(
        { storePath, sessionKey: key },
        async () => {
          workStarted.resolve();
          await releaseWork.promise;
        },
      );
      await workStarted.promise;

      await expect(
        runtime.session.createSessionEntry({
          cfg: {},
          key,
          initialEntry: {
            agentHarnessId: "codex",
            modelSelectionLocked: true,
          },
        }),
      ).rejects.toThrow(`Session "${key}" is still active; retry creation later.`);
      expect(runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" })).toBe(
        undefined,
      );

      releaseWork.resolve();
      await work;
    });
  });

  it("recovers an exact initializer without replacing its label or title", async () => {
    const naming = { label: "Operator label", displayName: "Original title snapshot" };
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-recovery" },
      async (state) => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:codex-recovery";
        const sessionId = "interrupted-initializer";
        const sessionFile = path.join(state.sessionsDir(), `${sessionId}.jsonl`);
        const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
        const initialPluginExtensions = {
          codex: { supervision: { sourceThreadId: "source-1", initializing: true } },
        };
        const persistedPluginExtensions = {
          codex: { supervision: { initializing: true, sourceThreadId: "source-1" } },
        };
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

        const recovered = await runtime.session.createSessionEntry({
          cfg: {},
          key,
          label: "Replacement label must be ignored",
          displayName: "Renamed upstream title must be ignored",
          spawnedCwd: "/workspace/project",
          sessionRoot: "/workspace",
          permissionMode: "guarded",
          recoverMatchingInitialEntry: true,
          initialEntry: {
            agentHarnessId: "codex",
            modelSelectionLocked: true,
            pluginExtensions: initialPluginExtensions,
          },
          afterCreate: async (created) => {
            expect(created.sessionId).toBe(sessionId);
            expect(created.entry.initializationPending).toBe(true);
            return {
              pluginExtensions: {
                codex: { supervision: { sourceThreadId: "source-1", modelLocked: true } },
              },
            };
          },
        });

        expect(recovered.sessionId).toBe(sessionId);
        expect(recovered.entry.label).toBe(naming.label);
        expect(recovered.entry.displayName).toBe(naming.displayName);
        expect(recovered.entry.initializationPending).toBeUndefined();
        expect(recovered.entry.pluginExtensions).toEqual({
          codex: { supervision: { sourceThreadId: "source-1", modelLocked: true } },
        });
        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toEqual(recovered.entry);
      },
    );
  });

  it("does not recover an initializer from a different spawned workspace", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-recovery-cwd-mismatch" },
      async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:codex-recovery-cwd-mismatch";
        const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
        const existing = {
          sessionId: "foreign-workspace-initializer",
          updatedAt: Date.now(),
          delivery: { kind: "none" as const },
          initializationPending: true as const,
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          pluginExtensions: {
            codex: { supervision: { sourceThreadId: "source-1", initializing: true } },
          },
          spawnedCwd: "/workspace/other",
        };
        await runtime.session.upsertSessionEntry({
          storePath,
          sessionKey: key,
          entry: existing,
        });

        await expect(
          runtime.session.createSessionEntry({
            cfg: {},
            key,
            spawnedCwd: "/workspace/project",
            recoverMatchingInitialEntry: true,
            initialEntry: {
              agentHarnessId: "codex",
              modelSelectionLocked: true,
              pluginExtensions: {
                codex: { supervision: { sourceThreadId: "source-1", initializing: true } },
              },
            },
            afterCreate: async () => ({ pluginExtensions: {} }),
          }),
        ).rejects.toThrow("does not match its trusted recovery state");
        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toEqual(existing);
      },
    );
  });

  it("does not recover an initializing row with different trusted ownership", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-recovery-mismatch" },
      async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:codex-recovery-mismatch";
        const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
        const existing = {
          sessionId: "foreign-initializer",
          updatedAt: Date.now(),
          delivery: { kind: "none" as const },
          initializationPending: true as const,
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          pluginExtensions: {
            codex: { supervision: { sourceThreadId: "different-source", initializing: true } },
          },
        };
        await runtime.session.upsertSessionEntry({
          storePath,
          sessionKey: key,
          entry: existing,
        });

        await expect(
          runtime.session.createSessionEntry({
            cfg: {},
            key,
            recoverMatchingInitialEntry: true,
            initialEntry: {
              agentHarnessId: "codex",
              modelSelectionLocked: true,
              pluginExtensions: {
                codex: { supervision: { sourceThreadId: "source-1", initializing: true } },
              },
            },
            afterCreate: async () => ({ pluginExtensions: {} }),
          }),
        ).rejects.toThrow("does not match its trusted recovery state");
        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toEqual(existing);
      },
    );
  });

  it("does not recover or roll back a locked CLI row owned by another plugin", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-cli-recovery-owner" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:catalog-adopt:claude:foreign";
      const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
      const cliSessionBinding = {
        sessionId: "claude-source",
        forceReuse: true,
        forkNextResume: true,
      } as const;
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
      await runtime.session.upsertSessionEntry({ storePath, sessionKey: key, entry: existing });

      await expect(
        runtime.session.createSessionEntry({
          cfg: {},
          key,
          recoverMatchingInitialEntry: true,
          initialEntry: {
            cliBackendId: "claude-cli",
            model: "claude-opus-4-8",
            modelSelectionLocked: true,
            pluginOwnerId: "anthropic",
            cliSessionBinding,
          },
          afterCreate: async () => {
            throw new Error("must not run");
          },
        }),
      ).rejects.toThrow("does not match its trusted recovery state");
      expect(
        runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
      ).toEqual(existing);
    });
  });

  it("rejects work for a persisted initializer without an active process fence", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-restart-admission" },
      async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:codex-restart-pending";
        const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
        await runtime.session.upsertSessionEntry({
          storePath,
          sessionKey: key,
          entry: {
            sessionId: "interrupted-initializer",
            updatedAt: Date.now(),
            initializationPending: true,
          },
        });
        expect(isSessionLifecycleMutationActive(storePath, [key])).toBe(false);
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
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-rollback-race" },
      async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:codex-binding-race";
        let sessionId: string | undefined;

        await expect(
          runtime.session.createSessionEntry({
            cfg: {},
            key,
            initialEntry: {
              agentHarnessId: "codex",
              modelSelectionLocked: true,
            },
            afterCreate: async (created) => {
              sessionId = created.sessionId;
              await runtime.session.patchSessionEntry({
                sessionKey: created.key,
                update: () => ({ displayName: "claimed concurrently" }),
              });
              return {
                pluginExtensions: {
                  codex: { supervision: { modelLocked: true } },
                },
              };
            },
          }),
        ).rejects.toThrow("guarded rollback did not complete");

        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toMatchObject({
          sessionId,
          displayName: "claimed concurrently",
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        });
      },
    );
  });

  it("rejects title mutation in the pluginExtensions-only final patch", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-title-final-patch" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:dashboard:title-final-patch";
      await expect(
        runtime.session.createSessionEntry({
          cfg: {},
          key,
          displayName: "Initial title",
          initialEntry: { agentHarnessId: "codex" },
          afterCreate: async () => ({ pluginExtensions: {}, displayName: "Invalid replacement" }),
        }),
      ).rejects.toThrow("session creation final patch may only contain pluginExtensions");
      expect(runtime.session.getSessionEntry({ sessionKey: key })).toBeUndefined();
    });
  });
});

describe("plugin runtime session work admission", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-plugin-session-admission-");
  let storePath: string;
  const sessionKey = "agent:main:voice:caller";
  const sessionId = "voice-session-id";

  beforeEach(async () => {
    const tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "sessions.json");
    await createRuntimeAgent().session.upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId, updatedAt: Date.now() },
    });
  });

  it("waits for a queued archive mutation and rejects the stale start", async () => {
    const runtime = createRuntimeAgent();
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation("plugin-create", {
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
    const mutation = runExclusiveSessionLifecycleMutation("plugin-create", {
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

    const work = runtime.session.runWithWorkAdmission({ storePath, sessionKey }, async () => {});
    releaseMutation.resolve();
    await mutation;

    await expect(work).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
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

    await interruptSessionWorkAdmissions({
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
  const originalAdmission = admission.createSqliteWorkerOperationAdmission;
  const originalOperation = workerStore.runOpenClawStateWorkerOperation;
  const originalMkdir = fsPromises.mkdir;
  let phase: string | undefined;
  let workspace: string;
  const events: string[] = [];
  vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation((admit, data) =>
    originalAdmission((request, grant) => {
      phase = request.stage;
      try {
        admit(request, () => {
          events.push(`grant:${phase}`);
          return grant();
        });
      } finally {
        phase = undefined;
      }
    }, data),
  );
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
