import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry as loadInternalSessionEntry,
  replaceSessionEntry as replaceInternalSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeAgent } from "./runtime-agent.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("plugin runtime session isolation", () => {
  it("hides and preserves private recovery through injected session helpers", async () => {
    const storePath = path.join(
      tempDirs.make("openclaw-plugin-session-isolation-"),
      "sessions.json",
    );
    const sessionKey = "agent:main:plugin-runtime-isolation";
    const mainRestartRecovery = {
      chargedAttempts: 1,
      cycleId: "runtime-cycle",
      revision: 1,
    };
    await replaceInternalSessionEntry({ sessionKey, storePath }, {
      abortedLastRun: true,
      mainRestartRecovery,
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryRuns: [{ lifecycleGeneration: "runtime-generation", runId: "runtime-run" }],
      model: "gpt-5.5",
      sessionId: "runtime-session-before",
      updatedAt: 10,
    } as InternalSessionEntry);
    const runtime = createRuntimeAgent();

    expect(runtime.session.getSessionEntry({ sessionKey, storePath })).not.toHaveProperty(
      "mainRestartRecovery",
    );
    expect(runtime.session.listSessionEntries({ storePath })[0]?.entry).not.toHaveProperty(
      "mainRestartRecovery",
    );

    let callbackSawPrivateState = false;
    await runtime.session.patchSessionEntry({
      sessionKey,
      storePath,
      update: (entry) => {
        callbackSawPrivateState = Object.hasOwn(entry, "mainRestartRecovery");
        return {
          mainRestartRecovery: {
            chargedAttempts: 99,
            cycleId: "runtime-injection",
            revision: 99,
          },
          model: "gpt-5.6",
        } as unknown as Partial<SessionEntry>;
      },
    });
    expect(callbackSawPrivateState).toBe(false);
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      abortedLastRun: true,
      mainRestartRecovery,
      model: "gpt-5.6",
      restartRecoveryRuns: [{ lifecycleGeneration: "runtime-generation", runId: "runtime-run" }],
    });

    await runtime.session.upsertSessionEntry({
      entry: {
        sessionId: "runtime-session-before",
        updatedAt: 20,
      },
      sessionKey,
      storePath,
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      mainRestartRecovery,
      sessionId: "runtime-session-before",
    });

    await runtime.session.updateSessionStoreEntry({
      sessionKey,
      skipMaintenance: true,
      storePath,
      update: () => ({ sessionId: "runtime-session-after", updatedAt: 30 }),
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).not.toHaveProperty(
      "mainRestartRecovery",
    );
  });

  it("projects recovered session creation callbacks and results", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-session-isolation-recovery" },
      async (state) => {
        const runtime = createRuntimeAgent();
        const sessionKey = "agent:main:dashboard:isolation-recovery";
        const sessionId = "interrupted-isolation-initializer";
        const sessionFile = path.join(state.sessionsDir(), `${sessionId}.jsonl`);
        const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
        const mainRestartRecovery = {
          chargedAttempts: 1,
          cycleId: "create-isolation-cycle",
          revision: 1,
        };
        fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
        fs.writeFileSync(
          sessionFile,
          `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`,
        );
        await runtime.session.upsertSessionEntry({
          storePath,
          sessionKey,
          entry: {
            sessionId,
            sessionFile,
            updatedAt: Date.now(),
            initializationPending: true,
            agentHarnessId: "codex",
            modelSelectionLocked: true,
            pluginExtensions: {
              codex: { supervision: { initializing: true, sourceThreadId: "source-1" } },
            },
            spawnedCwd: "/workspace/project",
          },
        });
        await replaceInternalSessionEntry({ sessionKey, storePath }, {
          ...loadInternalSessionEntry({ sessionKey, storePath })!,
          mainRestartRecovery,
        } as InternalSessionEntry);

        const recovered = await runtime.session.createSessionEntry({
          cfg: {},
          key: sessionKey,
          spawnedCwd: "/workspace/project",
          recoverMatchingInitialEntry: true,
          initialEntry: {
            agentHarnessId: "codex",
            modelSelectionLocked: true,
            pluginExtensions: {
              codex: { supervision: { initializing: true, sourceThreadId: "source-1" } },
            },
          },
          afterCreate: async (created) => {
            expect(created.entry).not.toHaveProperty("mainRestartRecovery");
            return {
              pluginExtensions: {
                codex: { supervision: { modelLocked: true, sourceThreadId: "source-1" } },
              },
            };
          },
        });

        expect(recovered.entry).not.toHaveProperty("mainRestartRecovery");
        expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
          mainRestartRecovery,
        });
      },
    );
  });
});
