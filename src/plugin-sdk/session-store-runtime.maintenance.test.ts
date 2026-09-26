import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assignSessionOwner,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { getSessionEntry, patchSessionEntry } from "./session-store-runtime.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("plugin session store maintenance", () => {
  it.each([
    { pruneAfterMs: 7 * DAY_MS, archivedAt: expect.any(Number) },
    { pruneAfterMs: 0, archivedAt: undefined },
    { pruneAfterMs: -DAY_MS, archivedAt: undefined },
  ])(
    "applies age retention $pruneAfterMs through entry patches",
    async ({ pruneAfterMs, archivedAt }) => {
      const storePath = path.join(tempDirs.make("openclaw-sdk-maintenance-"), "sessions.json");
      const staleSessionKey = "agent:main:stale";
      const activeSessionKey = "agent:main:active";
      const now = Date.now();
      const staleEntry = { sessionId: "session-stale", updatedAt: now - 8 * DAY_MS };
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: staleSessionKey, storePath },
        staleEntry,
      );
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: activeSessionKey, storePath },
        { sessionId: "session-active", updatedAt: now },
      );
      const actor = { id: "profile-owner", type: "human" as const };
      assignSessionOwner(
        { sessionKey: staleSessionKey, storePath },
        { assignedBy: actor, owner: actor },
      );

      await patchSessionEntry({
        sessionKey: activeSessionKey,
        storePath,
        maintenanceConfig: {
          mode: "enforce",
          pruneAfterMs,
          modelRunPruneAfterMs: DAY_MS,
          maxEntries: 100,
          resetArchiveRetentionMs: 7 * DAY_MS,
          maxDiskBytes: null,
          highWaterBytes: null,
        },
        update: () => ({ model: "gpt-5.5" }),
      });

      const readStaleEntry = () => getSessionEntry({ sessionKey: staleSessionKey, storePath });
      await vi.waitFor(() => expect(readStaleEntry()?.archivedAt).toEqual(archivedAt), {
        timeout: 5_000,
      });
      expect(readStaleEntry()).toMatchObject(staleEntry);
      const activeEntry = getSessionEntry({ sessionKey: activeSessionKey, storePath });
      expect(activeEntry).toMatchObject({ sessionId: "session-active", model: "gpt-5.5" });
      expect(activeEntry?.archivedAt).toBeUndefined();
    },
  );

  it("forwards maintenance suppression through entry patches", async () => {
    const storePath = path.join(tempDirs.make("openclaw-sdk-maintenance-"), "sessions.json");
    const staleSessionKey = "agent:main:stale";
    const activeSessionKey = "agent:main:active";
    const now = Date.now();
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: staleSessionKey, storePath },
      { sessionId: "session-stale", updatedAt: now - 8 * DAY_MS },
    );
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: activeSessionKey, storePath },
      { sessionId: "session-active", updatedAt: now },
    );

    await patchSessionEntry({
      sessionKey: activeSessionKey,
      storePath,
      maintenanceConfig: {
        mode: "enforce",
        pruneAfterMs: 7 * DAY_MS,
        modelRunPruneAfterMs: DAY_MS,
        maxEntries: 1,
        resetArchiveRetentionMs: 7 * DAY_MS,
        maxDiskBytes: null,
        highWaterBytes: null,
      },
      requireWriteSuccess: true,
      skipMaintenance: true,
      update: () => ({ model: "gpt-5.5" }),
    });

    expect(getSessionEntry({ sessionKey: staleSessionKey, storePath })).toMatchObject({
      sessionId: "session-stale",
    });
  });

  it("accepts pre-model-run maintenance configs through entry patches", async () => {
    const storePath = path.join(tempDirs.make("openclaw-sdk-maintenance-"), "sessions.json");
    const staleModelRunKey = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
    const activeSessionKey = "agent:main:active";
    const now = Date.now();
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: staleModelRunKey, storePath },
      { sessionId: "session-probe", updatedAt: now - 2 * DAY_MS },
    );
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: activeSessionKey, storePath },
      { sessionId: "session-active", updatedAt: now },
    );

    const legacyMaintenanceConfig = {
      mode: "enforce" as const,
      pruneAfterMs: 7 * DAY_MS,
      maxEntries: 500,
      resetArchiveRetentionMs: 7 * DAY_MS,
      maxDiskBytes: null,
      highWaterBytes: null,
    };
    await expect(
      patchSessionEntry({
        sessionKey: activeSessionKey,
        storePath,
        maintenanceConfig: legacyMaintenanceConfig,
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toMatchObject({ model: "gpt-5.5", sessionId: "session-active" });
    expect(getSessionEntry({ sessionKey: staleModelRunKey, storePath })).toMatchObject({
      sessionId: "session-probe",
    });
  });

  it.each([
    { modelRunPruneAfterMs: DAY_MS, modelRunSessionPresent: false },
    { modelRunPruneAfterMs: 0, modelRunSessionPresent: true },
    { modelRunPruneAfterMs: -DAY_MS, modelRunSessionPresent: true },
  ])(
    "applies model-run retention $modelRunPruneAfterMs through entry patches",
    async ({ modelRunPruneAfterMs, modelRunSessionPresent }) => {
      const storePath = path.join(tempDirs.make("openclaw-sdk-maintenance-"), "sessions.json");
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

      await vi.waitFor(
        () => {
          expect(getSessionEntry({ sessionKey: modelRunSessionKey, storePath }) != null).toBe(
            modelRunSessionPresent,
          );
        },
        { timeout: 5_000 },
      );
    },
  );
});
