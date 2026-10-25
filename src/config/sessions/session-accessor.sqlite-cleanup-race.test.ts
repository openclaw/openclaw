import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { runSessionMutation } from "../../sessions/session-controller.lifecycle.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  applySessionEntryLifecycleMutation as mutateLifecycle,
  cleanupSessionLifecycleArtifactsCore as cleanupArtifacts,
  deleteSessionEntryLifecycle as deleteLifecycle,
  loadSessionEntry as readEntry,
  loadTranscriptEvents as readTranscript,
  replaceSessionEntry as replaceEntry,
  replaceSessionEntrySync as replaceEntrySync,
  type TranscriptEvent,
} from "./session-accessor.js";
import {
  readSqliteSessionGenerationClaim,
  readSqliteSessionGenerationWindows,
} from "./session-accessor.sqlite-generation-copy.js";
import * as reclamation from "./session-accessor.sqlite-reclamation-run.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { replaceTranscriptEvents as replaceTranscript } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { runByteLimitedArchiveCleanupFixture } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

const hooks = vi.hoisted(() => ({
  synchronous: false,
  before: undefined as (() => Promise<void>) | undefined,
  after: undefined as (() => void | Promise<void>) | undefined,
  afterSync: undefined as (() => void) | undefined,
  observe: undefined as ((sessionIds: string[]) => void) | undefined,
  publicationFailure: undefined as Error | undefined,
}));
// Mutate after the real Worker returns, before cleanup opens its final transaction.
vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      if (!hooks.synchronous) {
        await hooks.before?.();
      }
      hooks.observe?.(args[0].map((plan) => plan.sessionId));
      const result = await actual.materializeSessionStateDeletePlans(...args);
      if (hooks.synchronous) {
        hooks.afterSync?.();
      } else {
        await hooks.after?.();
      }
      return result;
    },
  };
});
vi.mock("./session-accessor.sqlite-archive-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./session-accessor.sqlite-archive-store.js")>();
  return {
    ...actual,
    publishSessionStateArchives: async (
      ...args: Parameters<typeof actual.publishSessionStateArchives>
    ) => {
      const error = hooks.publicationFailure;
      hooks.publicationFailure = undefined;
      if (error) {
        throw error;
      }
      return await actual.publishSessionStateArchives(...args);
    },
  };
});
describe("cleanup races", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-cleanup-race-");
  type Events = Parameters<typeof replaceTranscript>[1];

  let tempDir: string;
  let storePath: string;
  let now: number;
  beforeEach(() => {
    hooks.synchronous = false;
    tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    now = Date.now();
  });
  afterEach(() => {
    hooks.before = undefined;
    hooks.after = undefined;
    hooks.observe = undefined;
    hooks.publicationFailure = undefined;
  });

  async function seed(
    sessionId: string,
    entry: Partial<SessionEntry> = {},
    events?: Events,
    options: { sessionKey?: string; agentId?: string } = {},
  ) {
    const scope = {
      storePath,
      sessionId,
      ...options,
      sessionKey: options.sessionKey ?? `agent:main:cleanup-race-${sessionId}`,
    };
    // Automatic maintenance must not consume the explicit cleanup's archive hooks.
    replaceEntrySync(scope, { sessionId, updatedAt: now, ...entry });
    if (events) {
      await replaceTranscript(scope, events);
    }
    return scope;
  }
  const marker = (runId = "cleanup-race-marker", timestamp = now - 600_000) => ({
    type: "metadata",
    runId,
    timestamp: new Date(timestamp).toISOString(),
  });
  const transcript = (id: string) => ({
    type: "session",
    id,
    content: "cleanup-race-marker transcript",
  });
  const cleanup = (options: Partial<Parameters<typeof cleanupArtifacts>[0]> = {}) =>
    cleanupArtifacts({
      storePath,
      sessionKeySegmentPrefix: "cleanup-race-",
      transcriptContentMarker: "cleanup-race-marker",
      orphanTranscriptMinAgeMs: 300_000,
      nowMs: now,
      ...options,
    });
  function database() {
    const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
    assert(target.path, "expected cleanup database path");
    return openOpenClawAgentDatabase({ agentId: "main", path: target.path });
  }
  const deletion = (sessionKey: string) =>
    deleteLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
  async function writerDuringArchive<T>(start: () => Promise<T>) {
    const writer = await seed("writer");
    const entered = createDeferred();
    const release = createDeferred();
    hooks.before = async () => {
      entered.resolve();
      await release.promise;
    };
    const operation = start();
    const operations: Promise<unknown>[] = [operation];
    onTestFinished(async () => {
      release.resolve();
      await Promise.allSettled(operations);
    });
    await entered.promise;
    const write = replaceEntry(writer, {
      sessionId: writer.sessionId,
      updatedAt: now + 1,
      label: "progressed",
    });
    operations.push(write);
    try {
      await expect(write).resolves.toMatchObject({ label: "progressed" });
    } finally {
      release.resolve();
    }
    return await operation;
  }

  it("preserves foreign plugin ownership while reclaiming owned and legacy rows", async () => {
    const entry = { updatedAt: now - 600_000 };
    const owned = await seed("owned", { ...entry, pluginOwnerId: "memory-core" });
    const legacy = await seed("legacy", entry);
    const foreign = await seed("foreign", { ...entry, pluginOwnerId: "other-plugin" });
    const foreignEntry = { ...entry, pluginOwnerId: "other-plugin" };
    const event = marker("cleanup-race-marker-foreign");
    const history = await seed("foreign-history-previous", foreignEntry, [event], {
      sessionKey: "agent:main:foreign-history",
    });
    await replaceEntry(history, {
      sessionId: "foreign-history-current",
      updatedAt: now,
      pluginOwnerId: "other-plugin",
    });
    const placeholder = await seed("foreign-placeholder-session", foreignEntry, [event]);
    const db = database();
    db.db
      .prepare("UPDATE session_nodes SET entry_json = ?, entry_valid = ? WHERE session_key = ?")
      .run("{}", -1, placeholder.sessionKey);
    const mixed = await seed("mixed-foreign-history", foreignEntry, [event]);
    await replaceEntry(mixed, {
      ...entry,
      sessionId: "mixed-owned-current",
      previousSessionId: mixed.sessionId,
      pluginOwnerId: "memory-core",
    });
    await expect(cleanup({ pluginOwnerId: "memory-core" })).resolves.toEqual({
      removedEntries: 2,
      archivedTranscriptArtifacts: 0,
    });
    expect(readEntry(owned)).toBeUndefined();
    expect(readEntry(legacy)).toBeUndefined();
    expect(readEntry(foreign)).toMatchObject({ pluginOwnerId: "other-plugin" });
    await expect(readTranscript(history)).resolves.toEqual([event]);
    expect(
      db.db
        .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
        .get(placeholder.sessionKey),
    ).toEqual({ current_session_id: placeholder.sessionId });
    await expect(readTranscript(placeholder)).resolves.toEqual([event]);
    expect(readEntry(mixed)).toMatchObject({
      sessionId: "mixed-owned-current",
      previousSessionId: mixed.sessionId,
    });
  });

  it("keeps another agent's current and historical sessions in a shared SQLite store", async () => {
    storePath = path.join(tempDir, "shared.sqlite");
    const entry = { updatedAt: now - 600_000, pluginOwnerId: "memory-core" };
    const main = await seed("main-orphan", entry, undefined, { agentId: "main" });
    const foreign = await seed("researcher-orphan", entry, undefined, {
      agentId: "researcher",
      sessionKey: "agent:researcher:cleanup-race-researcher",
    });
    const historyEvent = marker("cleanup-race-marker-researcher-history");
    const history = await seed(
      "researcher-orphaned-history",
      { updatedAt: now - 600_000 },
      [historyEvent],
      { agentId: "researcher", sessionKey: "agent:researcher:normal-session" },
    );
    await replaceEntry(history, { sessionId: "researcher-current", updatedAt: now });
    await expect(cleanup({ agentId: "main", pluginOwnerId: "memory-core" })).resolves.toEqual({
      removedEntries: 1,
      archivedTranscriptArtifacts: 0,
    });
    expect(readEntry(main)).toBeUndefined();
    expect(readEntry(foreign)).toMatchObject({ sessionId: foreign.sessionId });
    await expect(readTranscript(history)).resolves.toEqual([historyEvent]);
  });

  it("revalidates entries before deleting their transcript state", async () => {
    const event = transcript("cleanup-race-session");
    const target = await seed(event.id, {}, [event]);
    const db = database();
    const refreshed = { label: "refreshed", sessionId: target.sessionId, updatedAt: now + 1 };
    hooks.after = () =>
      runOpenClawAgentWriteAdmission({ agentId: "main", path: db.path }, () => {
        db.db
          .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
          .run(JSON.stringify(refreshed), refreshed.updatedAt, target.sessionKey);
      });
    await expect(cleanup({ orphanTranscriptMinAgeMs: 0, nowMs: now + 60_000 })).rejects.toThrow(
      "SQLite lifecycle cleanup entry changed",
    );
    expect(readEntry(target)).toEqual(refreshed);
    await expect(readTranscript(target)).resolves.toEqual([event]);
  });

  it("releases the store writer while a historical generation is archived", async () => {
    const target = await seed("historical-race-current", {}, [
      transcript("historical-race-current"),
    ]);
    await replaceTranscript({ ...target, sessionId: "historical-race-unplanned" }, [
      transcript("historical-race-unplanned"),
    ]);
    await expect(writerDuringArchive(() => deletion(target.sessionKey))).resolves.toMatchObject({
      deleted: true,
    });
  });

  it("releases the store writer while lifecycle cleanup archives a transcript", async () => {
    await seed("cleanup-race-archived-session", { updatedAt: now - 600_000 }, [
      marker("cleanup-race-marker-archived"),
    ]);
    await expect(writerDuringArchive(() => cleanup())).resolves.toEqual({
      removedEntries: 1,
      archivedTranscriptArtifacts: 1,
    });
  });

  it("retains committed maintenance counts when archive publication fails", async () => {
    const target = await seed("maintenance-publication-failed", { updatedAt: 1 }, undefined, {
      sessionKey: "agent:main:subagent:maintenance-publication-failed",
    });
    hooks.publicationFailure = new Error("injected archive publication failure");
    const result = await mutateLifecycle({
      storePath,
      maintenanceOverride: { mode: "enforce", pruneAfterMs: 1 },
    });
    expect(result).toMatchObject({
      beforeCount: 1,
      afterCount: 0,
      modelRunPruned: 0,
      pruned: 1,
      capped: 0,
    });
    expect(readEntry(target)).toBeUndefined();
  });

  it("splits byte-limited cleanup into real worker batches", async () => {
    const batches: string[][] = [];
    hooks.observe = (ids) => {
      batches.push(ids);
    };
    const ids = await runByteLimitedArchiveCleanupFixture(storePath);
    expect(batches.toSorted((left, right) => left[0]!.localeCompare(right[0]!))).toEqual(
      ids.toSorted((left, right) => left.localeCompare(right)).map((id) => [id]),
    );
  });

  it("continues a maintenance batch after one entry changes", async () => {
    const entryCount = 66;
    const historyId = "maintenance-batch-historical-session";
    const sessions: Awaited<ReturnType<typeof seed>>[] = [];
    for (let index = 0; index < entryCount; index += 1) {
      const suffix = String(index).padStart(2, "0");
      sessions.push(
        await seed(
          `maintenance-batch-session-${suffix}`,
          { updatedAt: index === entryCount - 1 ? now : index + 1 },
          [transcript(`maintenance-batch-session-${suffix}`)],
          { sessionKey: `agent:main:subagent:maintenance-batch-${suffix}` },
        ),
      );
    }
    const historyOwner = sessions[entryCount - 2]!;
    await replaceTranscript({ ...historyOwner, sessionId: historyId }, [transcript(historyId)]);
    let currentBatch: string[] = [];
    let materializations = 0;
    let racedKey: string | undefined;
    hooks.observe = (ids) => {
      currentBatch = ids;
    };
    hooks.after = () => {
      if (++materializations !== 2) {
        return;
      }
      racedKey = sessions.find((session) => session.sessionId === currentBatch[0])?.sessionKey;
      assert(racedKey, "expected entry in the second batch");
      const current = readEntry({ sessionKey: racedKey, storePath });
      assert(current, "expected raced entry");
      replaceEntrySync(
        { sessionKey: racedKey, storePath },
        { ...current, label: "changed during batch materialization" },
      );
    };
    const published: string[] = [];
    onTestFinished(
      onSessionIdentityMutation((mutation) => {
        if (mutation.kind === "delete") {
          published.push(...mutation.previous.sessionKeys);
        }
      }),
    );
    const result = await mutateLifecycle({
      storePath,
      maintenanceOverride: { mode: "enforce", maxEntries: entryCount, pruneAfterMs: 60_000 },
    });
    expect(published).not.toContain(racedKey);
    expect(published).toHaveLength(64);
    expect(result).toMatchObject({
      beforeCount: entryCount,
      afterCount: 2,
      modelRunPruned: 0,
      pruned: 64,
      capped: 0,
    });
    expect(readEntry({ sessionKey: racedKey ?? "", storePath })).toMatchObject({
      label: "changed during batch materialization",
    });
    expect(readEntry(sessions.at(-1)!)).toBeDefined();
    await expect(readTranscript({ ...historyOwner, sessionId: historyId })).resolves.toHaveLength(
      0,
    );
    expect(
      database()
        .db.prepare("SELECT 1 AS present FROM session_nodes WHERE session_key = ?")
        .get(historyOwner.sessionKey),
    ).toBeDefined();
  });
});

describe("generation cleanup races", () => {
  const sessionDirs = useSessionStoreTempDirs(
    afterAll,
    "openclaw-session-generation-cleanup-race-",
  );

  let storePath: string;

  beforeEach(() => {
    hooks.synchronous = true;
    storePath = path.join(sessionDirs.make(), "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    hooks.afterSync = undefined;
    hooks.observe = undefined;
  });

  async function fixture(
    sessionKey: string,
    ids: string[],
    event: (id: string, index: number) => TranscriptEvent,
  ) {
    const scope = { sessionKey, storePath };
    // Do not schedule maintenance against these deliberately old generations.
    for (const [index, sessionId] of ids.entries()) {
      replaceEntrySync(scope, { sessionId, updatedAt: index + 1 });
      await replaceTranscript({ ...scope, sessionId }, [event(sessionId, index)]);
    }
    const currentEntry = expectDefined(readEntry(scope), "Expected current generation");
    const databaseOptions = {
      agentId: "main",
      path: expectDefined(
        resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
        "Expected generation cleanup database path",
      ),
    };
    const write = <T>(operation: (database: OpenClawAgentDatabase) => T) =>
      runOpenClawAgentWriteTransaction(operation, databaseOptions);
    const expected = write((database) => ({
      expectedDatabaseIdentity: readOpenClawAgentDatabaseIdentity(database).identity,
      expectedGenerations: readSqliteSessionGenerationWindows(database, [sessionKey], []).map(
        (window) => readSqliteSessionGenerationClaim(database, window),
      ),
    }));
    const remove = (archiveTranscript: boolean) =>
      deleteLifecycle({
        ...expected,
        storePath,
        archiveTranscript,
        expectedEntry: currentEntry,
        ...(!archiveTranscript ? { deleteTranscriptWithoutArchive: true } : {}),
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
    const transcript = (sessionId: string) => readTranscript({ ...scope, sessionId });
    return { databaseOptions, currentEntry, write, remove, transcript };
  }

  it.each(["target history", "other history", "current", "new history"] as const)(
    "preserves exact generation claims when %s changes after cleanup planning",
    async (changed) => {
      const sessionKey = "agent:main:generation-claim-race";
      const historicalIds = ["claim-history-first", "claim-history-second"];
      const currentId = "claim-current";
      const addedId = "claim-added-after-planning";
      const sessionIds = [...historicalIds, currentId];
      const event = (sessionId: string) => ({
        type: "message" as const,
        id: "answer",
        message: {
          role: "assistant" as const,
          content: `${sessionId} transcript`,
          idempotencyKey: "recorded-owner",
        },
      });
      const { databaseOptions, currentEntry, write, remove, transcript } = await fixture(
        sessionKey,
        sessionIds,
        event,
      );
      let plannedId: string | undefined;
      let injected = false;
      let mutation: { sessionId: string; rowsChanged: number } | undefined;
      let mutationError: unknown;
      hooks.observe = (ids) => {
        [plannedId] = ids;
      };
      hooks.afterSync = () => {
        if (injected || !plannedId || (changed === "new history") !== (plannedId === currentId)) {
          return;
        }
        injected = true;
        const sessionId =
          changed === "new history"
            ? addedId
            : changed === "current"
              ? currentId
              : changed === "other history"
                ? historicalIds.find((id) => id !== plannedId)!
                : plannedId;
        // Extraction has finished; the final transactional generation check has not run.
        try {
          mutation = write((database) => {
            const rowsChanged =
              changed === "new history"
                ? Number(
                    appendTranscriptEventInTransaction(
                      database,
                      { ...databaseOptions, sessionKey, sessionId },
                      event(sessionId),
                    ) !== false,
                  )
                : Number(
                    database.db
                      .prepare(
                        "UPDATE transcript_event_identities SET message_idempotency_key = NULL WHERE session_id = ? AND event_id = 'answer'",
                      )
                      .run(sessionId).changes,
                  );
            return { sessionId, rowsChanged };
          });
        } catch (error) {
          // Keep injection failure separate from the lifecycle result asserted below.
          mutationError = error;
        }
      };
      const result = await remove(false);
      expect(mutationError).toBeUndefined();
      expect(mutation, JSON.stringify({ plannedId, injected, result })).toMatchObject({
        rowsChanged: 1,
      });
      expect(result).toMatchObject({ deleted: false, expectedEntryMismatch: true });
      expect(readEntry({ sessionKey, storePath })).toEqual(currentEntry);
      const retainedIds = new Set([currentId]);
      if (changed === "target history") {
        for (const sessionId of historicalIds) {
          retainedIds.add(sessionId);
        }
      } else if (changed !== "current") {
        retainedIds.add(mutation!.sessionId);
      }
      const remaining = write((database) => ({
        windows: readSqliteSessionGenerationWindows(database, [sessionKey], []).map(
          (window) => window.session_id,
        ),
        identity: database.db
          .prepare(
            "SELECT message_idempotency_key FROM transcript_event_identities WHERE session_id = ? AND event_id = 'answer'",
          )
          .get(mutation!.sessionId),
      }));
      expect(remaining.windows).toEqual([...retainedIds].toSorted());
      expect(remaining.identity).toEqual({
        message_idempotency_key: changed === "new history" ? "recorded-owner" : null,
      });
      for (const sessionId of [...sessionIds, addedId]) {
        await expect(transcript(sessionId)).resolves.toEqual(
          retainedIds.has(sessionId) ? [event(sessionId)] : [],
        );
      }
    },
  );

  it("rejects a changed historical generation after publishing earlier history", async () => {
    const sessionKey = "agent:main:historical-guard-race";
    const sessionIds = ["historical-guard-first", "historical-guard-second", "guard-current"];
    const events = sessionIds.map((sessionId) => ({
      type: "session" as const,
      id: sessionId,
      content: `${sessionId} transcript`,
    }));
    const { currentEntry, write, remove, transcript } = await fixture(
      sessionKey,
      sessionIds,
      (_id, index) => events[index]!,
    );
    let materializations = 0;
    let materializingSessionId: string | undefined;
    let changedSessionId: string | undefined;
    hooks.observe = ([sessionId]) => {
      materializingSessionId = sessionId;
    };
    hooks.afterSync = () => {
      materializations += 1;
      if (materializations === 2) {
        const sessionId = expectDefined(materializingSessionId, "Expected planned history");
        changedSessionId = sessionId;
        expect(sessionIds.slice(0, 2)).toContain(sessionId);
        const original = expectDefined(
          events.find((event) => event.id === sessionId),
          "Expected planned generation transcript",
        );
        const originalJson = JSON.stringify(original);
        const changedJson = JSON.stringify({ ...original, content: "concurrent transcript" });
        write(({ db }) => {
          const identities = () => [
            db.prepare("SELECT * FROM session_nodes WHERE session_key = ?").get(sessionKey),
            db.prepare("SELECT * FROM session_windows WHERE session_id = ?").get(sessionId),
          ];
          const before = identities();
          const updated = db
            .prepare(
              "UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND event_json = ?",
            )
            .run(changedJson, sessionId, originalJson);
          expect(Number(updated.changes)).toBe(1);
          // This race must invalidate content even when generation metadata stays unchanged.
          expect(identities()).toEqual(before);
        });
      }
    };

    const result = await remove(true);

    expect(result).toMatchObject({ deleted: false, expectedEntryMismatch: true });
    expect(result.archivedTranscripts).toHaveLength(1);
    expect(materializations).toBe(2);
    expect(readEntry({ sessionKey, storePath })).toEqual(currentEntry);
    const archivedSessionId = result.archivedTranscripts[0]?.sessionId;
    expect(sessionIds.slice(0, 2)).toContain(archivedSessionId);
    expect(changedSessionId).toBeDefined();
    expect(changedSessionId).not.toBe(archivedSessionId);
    for (const [index, historicalSessionId] of sessionIds.slice(0, 2).entries()) {
      await expect(transcript(historicalSessionId)).resolves.toEqual(
        historicalSessionId === archivedSessionId
          ? []
          : [{ ...events[index]!, content: "concurrent transcript" }],
      );
    }
    await expect(transcript(sessionIds[2]!)).resolves.toEqual([events[2]!]);
  });
});

describe("cleanup reclamation", () => {
  const staleEntry = { deleted: false, expectedEntryMismatch: true };
  function metadata(now: number, runId = "cleanup-reclamation-marker") {
    return { type: "metadata", runId, timestamp: new Date(now - 600_000).toISOString() };
  }

  let storePath: string;
  beforeEach(() => {
    hooks.synchronous = true;
    storePath = path.join(tempDirs.make(), "agents/main/sessions/sessions.json");
  });
  afterEach(() => {
    hooks.afterSync = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const tempDirs = useSessionStoreTempDirs(afterEach, "openclaw-session-cleanup-reclamation-");
  function scope(sessionId: string) {
    return { sessionId, sessionKey: `agent:main:${sessionId}`, storePath };
  }
  function database() {
    const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
    assert.ok(target.path, "expected reclamation database path");
    return openOpenClawAgentDatabase({ agentId: "main", path: target.path });
  }
  const cleanup = (nowMs: number, options: Partial<Parameters<typeof cleanupArtifacts>[0]> = {}) =>
    cleanupArtifacts({
      storePath,
      sessionKeySegmentPrefix: "cleanup-reclamation-",
      transcriptContentMarker: "cleanup-reclamation-marker",
      orphanTranscriptMinAgeMs: 300_000,
      nowMs,
      ...options,
    });
  async function closeDatabases() {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
  }
  const archive = (sessionId: string) =>
    database()
      .db.prepare("SELECT * FROM session_transcript_archives WHERE session_id = ?")
      .get(sessionId);

  it.each(["replace", "delete"] as const)(
    "rejects a stale entry plan before mutation after an awaited %s",
    async (mutation) => {
      const current = scope("queued-entry-deletion");
      const entry = { sessionId: current.sessionId, updatedAt: Date.now() };
      const replacement = { ...entry, label: "changed by the preceding owner" };
      await replaceEntry(current, entry);
      await closeOpenClawAgentDatabaseByPathAsync(database().path);
      const deletionParams = {
        archiveTranscript: false,
        storePath,
        target: { canonicalKey: current.sessionKey, storeKeys: [current.sessionKey] },
      };
      const entered = createDeferred();
      const prepared = createDeferred();
      const prepare = reclamation.runSessionDeletionPlanning;
      vi.spyOn(reclamation, "runSessionDeletionPlanning").mockImplementationOnce(
        async (...args) => {
          const result = await prepare(...args);
          prepared.resolve();
          return result;
        },
      );
      const previous = runSessionMutation({
        scope: storePath,
        identities: [current.sessionKey, current.sessionId],
        run: async () => {
          entered.resolve();
          await prepared.promise;
          if (mutation === "replace") {
            await replaceEntry(current, replacement);
          } else {
            expect((await deleteLifecycle(deletionParams)).deleted).toBe(true);
          }
        },
      });
      let deletion: ReturnType<typeof deleteLifecycle> | undefined;
      try {
        await entered.promise;
        deletion = deleteLifecycle(deletionParams);
        // Preparation observes the old row while the preceding lifecycle owner is held.
        await awaitGateBeforeSettlement(
          previous,
          deletion,
          "Deletion completed without waiting for the preceding lifecycle owner",
        );
        await expect(deletion).resolves.toEqual({ ...staleEntry, archivedTranscripts: [] });
        if (mutation === "replace") {
          expect(readEntry(current)).toMatchObject(replacement);
        } else {
          expect(readEntry(current)).toBeUndefined();
        }
      } finally {
        prepared.resolve();
        await Promise.allSettled([previous, ...(deletion ? [deletion] : [])]);
      }
    },
  );

  it("keeps published history when the entry changes during final materialization", async () => {
    const current = scope("entry-materialization-run");
    const history = { ...current, sessionId: "entry-materialization-history" };
    const updatedAt = Date.now();
    const events = [{ type: "session", id: current.sessionId, content: "original transcript" }];
    await replaceEntry(history, { sessionId: history.sessionId, updatedAt });
    await replaceTranscript(history, [
      { type: "session", id: history.sessionId, content: "already published history" },
    ]);
    await replaceEntry(current, { sessionId: current.sessionId, updatedAt });
    await replaceTranscript(current, events);
    const expectedEntry = readEntry(current);
    assert.ok(expectedEntry, "expected guarded entry");
    const replacement = { ...expectedEntry, label: "concurrent replacement" };
    let materializations = 0;
    hooks.afterSync = () => {
      if (++materializations === 2) {
        replaceEntrySync(current, replacement);
      }
    };
    const result = await deleteLifecycle({
      archiveTranscript: true,
      expectedEntry,
      storePath,
      target: { canonicalKey: current.sessionKey, storeKeys: [current.sessionKey] },
    });
    expect(result).toMatchObject({
      ...staleEntry,
      archivedTranscripts: [expect.objectContaining({ sessionId: history.sessionId })],
    });
    expect(materializations).toBe(2);
    await expect(readTranscript(history)).resolves.toEqual([]);
    expect(readEntry(current)).toEqual(replacement);
    await expect(readTranscript(current)).resolves.toEqual(events);
  });

  it("reclaims cold orphan-only history and republishes pending archives on a cold empty pass", async () => {
    const now = Date.now();
    const history = { ...scope("orphaned-history"), sessionKey: "agent:main:current" };
    await replaceEntry(history, { sessionId: history.sessionId, updatedAt: now - 600_000 });
    await replaceTranscript(history, [metadata(now, "cleanup-reclamation-marker-orphan")]);
    const current = { sessionId: "current-session", updatedAt: now };
    await replaceEntry(history, current);
    await closeDatabases();
    const reclaimed = await cleanup(now);
    expect(reclaimed).toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 1 });
    expect(readEntry(history)).toMatchObject(current);
    await expect(readTranscript(history)).resolves.toEqual([]);
    const db = database();
    const archiveName = archive(history.sessionId)?.archive_name;
    assert.ok(typeof archiveName === "string", "expected published orphan archive");
    const archivePath = path.join(path.dirname(storePath), archiveName);
    const bytes = fs.readFileSync(archivePath);
    fs.rmSync(archivePath);
    db.db
      .prepare("UPDATE session_transcript_archives SET published_at = NULL WHERE session_id = ?")
      .run(history.sessionId);
    await closeDatabases();
    const empty = await cleanup(now);
    expect(empty).toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 0 });
    expect(fs.readFileSync(archivePath)).toEqual(bytes);
    expect(archive(history.sessionId)).toMatchObject({ published_at: expect.any(Number) });
    expect(readEntry(history)).toMatchObject(current);
  });

  it("keeps the event loop responsive while committing a large transcript", async () => {
    const rows = 100_000;
    const now = Date.now();
    const current = scope("cleanup-reclamation-large");
    const unrelated = scope("cleanup-reclamation-unrelated");
    const event = metadata(now);
    await replaceEntry(current, { sessionId: current.sessionId, updatedAt: now - 600_000 });
    await replaceEntry(unrelated, { sessionId: unrelated.sessionId, updatedAt: now });
    await replaceTranscript(current, [event]);
    const db = database();
    const insert = db.db.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
    );
    const eventJson = JSON.stringify(event);
    runSqliteImmediateTransactionSync(requireNativeSqliteDatabase(db.db), () => {
      // The one-event replacement seeds seq 0; append without allocating 100k fixture objects.
      for (let index = 1; index < rows; index += 1) {
        insert.run(current.sessionId, index, eventJson, now - 600_000 + index);
      }
      insert.run(unrelated.sessionId, 0, '{"type":"metadata","runId":"unrelated"}', now);
    });
    const samples: number[] = [];
    let previous = 0;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    hooks.afterSync = () => {
      previous = performance.now();
      heartbeat = setInterval(() => {
        const time = performance.now();
        samples.push(time - previous);
        previous = time;
      }, 10);
    };
    using heartbeatCleanup = { [Symbol.dispose]: () => clearInterval(heartbeat) };
    const result = await cleanup(now, { sessionKeySegmentPrefix: "cleanup-reclamation-large" });
    heartbeatCleanup[Symbol.dispose]();
    expect(result).toEqual({ removedEntries: 1, archivedTranscriptArtifacts: 1 });
    expect(samples.length).toBeGreaterThan(0);
    expect(Math.max(...samples)).toBeLessThan(500);
    expect(readEntry(current)).toBeUndefined();
    expect(readEntry(unrelated)).toMatchObject({ sessionId: unrelated.sessionId });
    expect(
      db.db
        .prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
        .get(current.sessionId),
    ).toEqual({ count: 0 });
    expect(archive(current.sessionId)).toMatchObject({
      archive_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      published_at: expect.any(Number),
    });
  }, 120_000);
});
