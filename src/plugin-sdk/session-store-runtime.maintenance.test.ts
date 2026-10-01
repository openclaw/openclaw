import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { observeSessionMaintenanceCompletion } from "../config/sessions/session-accessor.sqlite-maintenance.test-support.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { getSessionEntry, patchSessionEntry } from "./session-store-runtime.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sdk-maintenance-");

describe("plugin session store maintenance", () => {
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
