import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { observeSessionMaintenanceCompletion } from "../config/sessions/session-accessor.sqlite-maintenance.test-support.js";
import { prepareSessionEntryReplacementDatabase } from "../config/sessions/session-accessor.sqlite-replacement-worker.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  cleanupSessionLifecycleArtifacts,
  getSessionEntry,
  patchSessionEntry,
} from "./session-store-runtime.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sdk-maintenance-");

describe("plugin session store maintenance", () => {
  it("keeps lifecycle cleanup in the explicit environment while its executor is live", async () => {
    await withOpenClawTestState({ layout: "state-only", applyEnv: false }, async ({ env }) => {
      expect(resolveOpenClawStateSqlitePath(env)).not.toBe(resolveOpenClawStateSqlitePath());
      const scope = { agentId: "main", env };
      const expiredKey = "agent:main:sdk-cleanup-env-expired";
      const retainedKey = "agent:main:retained";
      const seed = (sessionKey: string, sessionId: string) => {
        const entry = { sessionId, updatedAt: 1 };
        return patchSessionEntry({
          ...scope,
          sessionKey,
          fallbackEntry: entry,
          replaceEntry: true,
          skipMaintenance: true,
          requireWriteSuccess: true,
          update: () => entry,
        });
      };
      await seed(expiredKey, "expired");
      // A live target exposes an incorrect fallback to the process environment.
      const execution = captureOpenClawAgentDatabaseExecution(scope);
      try {
        await seed(retainedKey, "retained");
        await prepareSessionEntryReplacementDatabase(
          { ...scope, path: execution.path },
          () => execution.assertCurrent(),
          execution,
        );
        expect(execution.fileIdentity).toBeDefined();
        await expect(
          cleanupSessionLifecycleArtifacts({
            ...scope,
            archiveRemovedEntryTranscripts: false,
            sessionKeySegmentPrefix: "sdk-cleanup-env-",
            transcriptContentMarker: "sdk-cleanup-env-",
            orphanTranscriptMinAgeMs: 0,
            nowMs: 10_000,
          }),
        ).resolves.toEqual({ removedEntries: 1, archivedTranscriptArtifacts: 0 });
        expect(getSessionEntry({ ...scope, sessionKey: expiredKey })).toBeUndefined();
        expect(getSessionEntry({ ...scope, sessionKey: retainedKey })?.sessionId).toBe("retained");
        execution.assertCurrent();
      } finally {
        await execution.release();
      }
    });
  });

  it.each([
    { modelRunPruneAfterMs: DAY_MS, modelRunSessionPresent: false },
    { modelRunPruneAfterMs: 0, modelRunSessionPresent: true },
    { modelRunPruneAfterMs: -DAY_MS, modelRunSessionPresent: true },
  ])(
    "applies model-run retention $modelRunPruneAfterMs through entry patches",
    async ({ modelRunPruneAfterMs, modelRunSessionPresent }) => {
      const storePath = path.join(sessionDirs.make(), "sessions.json");
      const modelRunSessionKey =
        "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
      const oldSessionKey = "agent:main:old";
      const activeSessionKey = "agent:main:active";
      const now = Date.now();
      const seed = (sessionKey: string, sessionId: string, updatedAt: number) =>
        replaceSessionEntrySync(
          { agentId: "main", sessionKey, storePath },
          { sessionId, updatedAt },
        );
      seed(modelRunSessionKey, "session-model-run", now - 2 * DAY_MS);
      seed(oldSessionKey, "session-old", now - 3 * DAY_MS);
      seed(activeSessionKey, "session-active", now);

      const done = observeSessionMaintenanceCompletion(
        path.join(path.dirname(storePath), "openclaw-agent.sqlite"),
      );
      await patchSessionEntry({
        sessionKey: activeSessionKey,
        storePath,
        maintenanceConfig: {
          mode: "enforce",
          pruneAfterMs: 30 * DAY_MS,
          modelRunPruneAfterMs,
          maxEntries: 2,
          resetArchiveRetentionMs: 7 * DAY_MS,
          maxDiskBytes: null,
          highWaterBytes: null,
        },
        update: () => ({ model: "gpt-5.6-luna" }),
      });

      await done;
      expect(getSessionEntry({ sessionKey: modelRunSessionKey, storePath }) != null).toBe(
        modelRunSessionPresent,
      );
    },
  );
});
