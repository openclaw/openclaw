import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  appendTranscriptEvent,
  assignSessionOwner,
  loadSessionEntry as loadInternalSessionEntry,
  patchSessionEntryCore as patchInternalSessionEntry,
  replaceSessionEntry as replaceInternalSessionEntry,
} from "../config/sessions/session-accessor.js";
import { observeSessionMaintenanceCompletion } from "../config/sessions/session-accessor.sqlite-maintenance-completion.test-support.js";
import type * as ConfigSessionTypes from "../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  cleanupSessionLifecycleArtifacts,
  deleteSessionEntry,
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  readSessionUpdatedAt,
  resolveSessionStoreBackupPaths,
  updateSessionStoreEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "./session-store-runtime.js";

type InternalSessionEntry = ConfigSessionTypes.InternalSessionEntry;

const DAY_MS = 24 * 60 * 60 * 1000;
const sessionEntryKeepsRecoveryPrivate: "mainRestartRecovery" extends keyof SessionEntry
  ? false
  : true = true;
const configSessionEntryKeepsRecoveryPrivate: "mainRestartRecovery" extends keyof ConfigSessionTypes.SessionEntry
  ? false
  : true = true;
void sessionEntryKeepsRecoveryPrivate;
void configSessionEntryKeepsRecoveryPrivate;

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sdk-session-store-");

describe("session-store-runtime", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "sessions.json");
  });

  async function seedSessionEntry(sessionKey: string, entry: SessionEntry): Promise<void> {
    await patchInternalSessionEntry({ agentId: "main", sessionKey, storePath }, () => entry, {
      fallbackEntry: entry,
      replaceEntry: true,
      skipMaintenance: true,
    });
  }

  async function seedRecoveringSession(
    sessionKey: string,
    sessionId: string,
    targetStorePath = storePath,
  ) {
    const entry: InternalSessionEntry = {
      abortedLastRun: true,
      mainRestartRecovery: { chargedAttempts: 1, cycleId: "rotation-cycle", revision: 1 },
      restartRecoveryRuns: [{ lifecycleGeneration: "rotation-generation", runId: "rotation-run" }],
      sessionId,
      updatedAt: 10,
    };
    await replaceInternalSessionEntry(
      { agentId: "main", sessionKey, storePath: targetStorePath },
      entry,
    );
  }

  function assignOwner(sessionKey: string): void {
    const actor = { id: "profile-owner", type: "human" as const };
    assignSessionOwner({ sessionKey, storePath }, { assignedBy: actor, owner: actor });
  }

  function expectRecoveryCleared(params: {
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }): void {
    const entry = loadInternalSessionEntry({
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
    expect(entry).toMatchObject({ sessionId: params.sessionId });
    expect(entry?.abortedLastRun).not.toBe(true);
    expect(entry?.restartRecoveryRuns).toBeUndefined();
    expect(entry).not.toHaveProperty("mainRestartRecovery");
  }

  it("keeps the public session read shape while using accessor-backed exports", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        model: "gpt-5.5",
        sessionId: "session-1",
        updatedAt: 10,
      },
    });

    expect(getSessionEntry({ sessionKey, storePath })).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: 10,
    });
    expect(readSessionUpdatedAt({ sessionKey, storePath })).toEqual(expect.any(Number));
    expect(listSessionEntries({ storePath })).toEqual([
      {
        sessionKey,
        entry: expect.objectContaining({
          model: "gpt-5.5",
          sessionId: "session-1",
          updatedAt: 10,
        }),
      },
    ]);
    const detachedEntry = getSessionEntry({ sessionKey, storePath })!;
    detachedEntry.model = "mutated";
    expect(getSessionEntry({ sessionKey, storePath })?.model).toBe("gpt-5.5");
    expect(detachedEntry.sessionFile).toBeUndefined();

    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-1",
        updatedAt: 20,
      },
    });
    expect(getSessionEntry({ sessionKey, storePath })?.model).toBeUndefined();
  });

  it("keeps the public entry mutation signature while delegating to the seam", async () => {
    const sessionKey = "agent:main:main";

    await expect(
      updateSessionStoreEntry({
        sessionKey,
        storePath,
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toBeNull();

    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-1",
        updatedAt: 10,
      },
    });

    const beforePatch = getSessionEntry({ sessionKey, storePath });
    await expect(
      patchSessionEntry({
        sessionKey,
        storePath,
        preserveActivity: true,
        update: (_entry, context) => ({
          providerOverride: context.existingEntry ? "openai" : "missing",
          updatedAt: 20,
        }),
      }),
    ).resolves.toMatchObject({
      providerOverride: "openai",
      sessionId: "session-1",
      updatedAt: beforePatch?.updatedAt,
    });

    await expect(
      updateSessionStoreEntry({
        sessionKey,
        storePath,
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toMatchObject({
      model: "gpt-5.5",
      providerOverride: "openai",
      sessionId: "session-1",
    });
  });

  it("hides core recovery state and preserves it across public mutations", async () => {
    const sessionKey = "agent:main:recovery-owned";
    const mainRestartRecovery = {
      chargedAttempts: 1,
      cycleId: "cycle-1",
      reservation: {
        attempt: 1,
        lifecycleGeneration: "generation-1",
        runId: "run-1",
      },
      revision: 1,
    };
    await replaceInternalSessionEntry({ sessionKey, storePath }, {
      abortedLastRun: true,
      mainRestartRecovery,
      model: "gpt-5.5",
      restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
      sessionId: "session-recovery",
      updatedAt: 10,
    } as InternalSessionEntry);

    expect(getSessionEntry({ sessionKey, storePath })).not.toHaveProperty("mainRestartRecovery");
    expect(listSessionEntries({ storePath })[0]?.entry).not.toHaveProperty("mainRestartRecovery");

    await patchSessionEntry({
      sessionKey,
      storePath,
      update: (entry) => {
        entry.restartRecoveryRuns?.splice(0);
        return {
          abortedLastRun: false,
          mainRestartRecovery: undefined,
          model: "gpt-5.6",
          restartRecoveryRuns: undefined,
        } as unknown as Partial<SessionEntry>;
      },
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      abortedLastRun: true,
      mainRestartRecovery,
      model: "gpt-5.6",
      restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
    });

    await updateSessionStoreEntry({
      sessionKey,
      storePath,
      update: () => ({ abortedLastRun: false, restartRecoveryRuns: undefined }),
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      abortedLastRun: true,
      mainRestartRecovery,
      restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
    });

    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-recovery",
        updatedAt: 20,
      },
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      abortedLastRun: true,
      mainRestartRecovery,
      restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
      sessionId: "session-recovery",
      updatedAt: 20,
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })?.model).toBeUndefined();
  });

  it("clears core recovery state when public replacements change session identity", async () => {
    const patchKey = "agent:main:telegram:direct:patch-rotation";
    const upsertKey = "agent:main:telegram:direct:upsert-rotation";
    const upsertStorePath = path.join(tempDir, "upsert-sessions.json");
    await seedRecoveringSession(patchKey, "patch-before");
    await seedRecoveringSession(upsertKey, "upsert-before", upsertStorePath);

    await patchSessionEntry({
      replaceEntry: true,
      sessionKey: patchKey,
      storePath,
      update: () => ({ sessionId: "patch-after", updatedAt: 20 }),
    });
    await upsertSessionEntry({
      entry: {
        abortedLastRun: true,
        restartRecoveryRuns: [{ lifecycleGeneration: "upsert-generation", runId: "upsert-run" }],
        sessionId: "upsert-after",
        updatedAt: 20,
      },
      sessionKey: upsertKey,
      storePath: upsertStorePath,
    });

    expectRecoveryCleared({ sessionId: "patch-after", sessionKey: patchKey, storePath });
    expectRecoveryCleared({
      sessionId: "upsert-after",
      sessionKey: upsertKey,
      storePath: upsertStorePath,
    });
  });

  it("clears core recovery state when public patches change session identity", async () => {
    const patchKey = "agent:main:telegram:direct:patch-rotation";
    const updateKey = "agent:main:telegram:direct:update-rotation";
    const updateStorePath = path.join(tempDir, "update-patch-sessions.json");
    await seedRecoveringSession(patchKey, "patch-before");
    await seedRecoveringSession(updateKey, "update-before", updateStorePath);

    await patchSessionEntry({
      sessionKey: patchKey,
      skipMaintenance: true,
      storePath,
      update: () => ({ sessionId: "patch-after", updatedAt: 20 }),
    });
    await updateSessionStoreEntry({
      sessionKey: updateKey,
      skipMaintenance: true,
      storePath: updateStorePath,
      update: () => ({ sessionId: "update-after", updatedAt: 20 }),
    });

    expectRecoveryCleared({ sessionId: "patch-after", sessionKey: patchKey, storePath });
    expectRecoveryCleared({
      sessionId: "update-after",
      sessionKey: updateKey,
      storePath: updateStorePath,
    });
  });

  it.each([
    { pruneAfterMs: 7 * DAY_MS, archivedAt: expect.any(Number) },
    { pruneAfterMs: 0, archivedAt: undefined },
  ])(
    "applies age retention $pruneAfterMs through entry patches",
    async ({ pruneAfterMs, archivedAt }) => {
      const staleSessionKey = "agent:main:stale";
      const activeSessionKey = "agent:main:active";
      const now = Date.now();
      const staleEntry = { sessionId: "session-stale", updatedAt: now - 8 * DAY_MS };
      await seedSessionEntry(staleSessionKey, staleEntry);
      await seedSessionEntry(activeSessionKey, { sessionId: "session-active", updatedAt: now });
      assignOwner(staleSessionKey);

      const done = observeSessionMaintenanceCompletion(path.join(tempDir, "openclaw-agent.sqlite"));
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

      await done;
      const retainedEntry = getSessionEntry({ sessionKey: staleSessionKey, storePath });
      expect(retainedEntry?.archivedAt).toEqual(archivedAt);
      expect(retainedEntry).toMatchObject(staleEntry);
      const activeEntry = getSessionEntry({ sessionKey: activeSessionKey, storePath });
      expect(activeEntry).toMatchObject({ sessionId: "session-active", model: "gpt-5.5" });
      expect(activeEntry?.archivedAt).toBeUndefined();
    },
  );

  it("forwards maintenance suppression through entry patches", async () => {
    const staleSessionKey = "agent:main:stale";
    const activeSessionKey = "agent:main:active";
    const now = Date.now();
    await seedSessionEntry(staleSessionKey, {
      sessionId: "session-stale",
      updatedAt: now - 8 * DAY_MS,
    });
    await seedSessionEntry(activeSessionKey, {
      sessionId: "session-active",
      updatedAt: now,
    });

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
    const staleModelRunKey = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
    const activeSessionKey = "agent:main:active";
    const now = Date.now();
    await seedSessionEntry(staleModelRunKey, {
      sessionId: "session-probe",
      updatedAt: now - 2 * DAY_MS,
    });
    await seedSessionEntry(activeSessionKey, {
      sessionId: "session-active",
      updatedAt: now,
    });

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
    ).resolves.toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-active",
    });

    expect(getSessionEntry({ sessionKey: staleModelRunKey, storePath })).toMatchObject({
      sessionId: "session-probe",
    });
  });

  it("deletes entries by session identity", async () => {
    const sessionKey = "agent:main:delete-me";
    await seedSessionEntry(sessionKey, {
      sessionId: "session-delete-me",
      updatedAt: Date.now(),
    });

    await expect(deleteSessionEntry({ sessionKey, storePath })).resolves.toBe(true);
    await expect(deleteSessionEntry({ sessionKey, storePath })).resolves.toBe(false);
    expect(getSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });

  it("guards entry deletion against a concurrent session update", async () => {
    const sessionKey = "agent:main:delete-guarded";
    const updatedAt = Date.now();
    await seedSessionEntry(sessionKey, { sessionId: "session-delete-guarded", updatedAt });

    await expect(
      deleteSessionEntry({
        expectedSessionId: "older-session",
        expectedUpdatedAt: updatedAt - 1,
        sessionKey,
        storePath,
      }),
    ).resolves.toBe(false);
    expect(getSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "session-delete-guarded",
      updatedAt,
    });

    await expect(
      deleteSessionEntry({
        expectedSessionId: "session-delete-guarded",
        expectedUpdatedAt: updatedAt,
        sessionKey,
        storePath,
      }),
    ).resolves.toBe(true);
  });

  it("guards entry deletion when the earlier snapshot had no session id", async () => {
    const sessionKey = "agent:main:delete-guarded-absent-id";
    const updatedAt = Date.now();
    await seedSessionEntry(sessionKey, { sessionId: "replacement-session", updatedAt });

    await expect(
      deleteSessionEntry({
        expectedSessionId: null,
        expectedUpdatedAt: updatedAt,
        sessionKey,
        storePath,
      }),
    ).resolves.toBe(false);
    expect(getSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "replacement-session",
      updatedAt,
    });
  });

  it("resolves agent-scoped custom SQLite stores for backups", () => {
    const customStorePath = path.join(tempDir, "custom", "sessions.json");

    expect(
      resolveSessionStoreBackupPaths({
        agentId: "support",
        storePath: customStorePath,
      }),
    ).toContain(path.join(tempDir, "custom", "openclaw-agent.support.sqlite"));
  });

  it("cleans lifecycle artifacts through the accessor-backed SDK wrapper", async () => {
    const sessionId = "lifecycle-owned-old";
    const sessionKey = `agent:main:${sessionId}`;
    const oldTimestamp = Date.now() - 600_000;
    await seedSessionEntry(sessionKey, { sessionId, updatedAt: oldTimestamp });
    await seedSessionEntry("agent:main:regular", { sessionId: "regular", updatedAt: Date.now() });
    assignOwner(sessionKey);
    await appendTranscriptEvent(
      { agentId: "main", sessionKey, sessionId, storePath },
      {
        runId: sessionId,
        timestamp: new Date(oldTimestamp).toISOString(),
        type: "metadata",
      },
    );

    await expect(
      cleanupSessionLifecycleArtifacts({
        agentId: "main",
        storePath,
        sessionKeySegmentPrefix: "lifecycle-owned-",
        transcriptContentMarker: '"runId":"lifecycle-owned-',
        orphanTranscriptMinAgeMs: 300_000,
      }),
    ).resolves.toEqual({
      archivedTranscriptArtifacts: 1,
      removedEntries: 1,
    });

    expect(getSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expect(getSessionEntry({ sessionKey: "agent:main:regular", storePath })).toMatchObject({
      sessionId: "regular",
    });
    expect(
      fs
        .readdirSync(tempDir)
        .filter((file) => file.startsWith("lifecycle-owned-old.jsonl.deleted.")),
    ).toHaveLength(1);
  });

  it("honors lifecycle cleanup without archiving removed entry transcripts", async () => {
    const sessionKey = "agent:main:lifecycle-owned-discard";
    const oldTimestamp = Date.now() - 600_000;
    await seedSessionEntry(sessionKey, {
      sessionId: "lifecycle-owned-discard",
      updatedAt: oldTimestamp,
    });
    await appendTranscriptEvent(
      { agentId: "main", sessionKey, sessionId: "lifecycle-owned-discard", storePath },
      {
        runId: "lifecycle-owned-discard",
        timestamp: new Date(oldTimestamp).toISOString(),
        type: "metadata",
      },
    );

    await expect(
      cleanupSessionLifecycleArtifacts({
        agentId: "main",
        archiveRemovedEntryTranscripts: false,
        storePath,
        sessionKeySegmentPrefix: "lifecycle-owned-",
        transcriptContentMarker: '"runId":"lifecycle-owned-',
        orphanTranscriptMinAgeMs: 300_000,
      }),
    ).resolves.toEqual({
      archivedTranscriptArtifacts: 0,
      removedEntries: 1,
    });

    expect(getSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expect(
      fs
        .readdirSync(tempDir)
        .filter((file) => file.startsWith("lifecycle-owned-discard.jsonl.deleted.")),
    ).toHaveLength(0);
  });
});
