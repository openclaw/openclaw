import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  applySessionEntryLifecycleMutation,
  cleanupSessionLifecycleArtifactsCore,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { runByteLimitedArchiveCleanupFixture } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

const hooks = vi.hoisted(() => ({
  before: undefined as (() => Promise<void>) | undefined,
  after: undefined as (() => void | Promise<void>) | undefined,
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
      await hooks.before?.();
      hooks.observe?.(args[0].map((plan) => plan.sessionId));
      const result = await actual.materializeSessionStateDeletePlans(...args);
      await hooks.after?.();
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
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-cleanup-race-");
type Events = Parameters<typeof replaceTranscriptEvents>[1];

describe("SQLite lifecycle cleanup races", () => {
  let tempDir: string;
  let storePath: string;
  let now: number;
  beforeEach(() => {
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
    replaceSessionEntrySync(scope, { sessionId, updatedAt: now, ...entry });
    if (events) {
      await replaceTranscriptEvents(scope, events);
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
  const cleanup = (
    options: Partial<Parameters<typeof cleanupSessionLifecycleArtifactsCore>[0]> = {},
  ) =>
    cleanupSessionLifecycleArtifactsCore({
      storePath,
      sessionKeySegmentPrefix: "cleanup-race-",
      transcriptContentMarker: "cleanup-race-marker",
      orphanTranscriptMinAgeMs: 300_000,
      nowMs: now,
      ...options,
    });
  function database() {
    const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
    if (!target.path) {
      throw new Error("expected cleanup database path");
    }
    return openOpenClawAgentDatabase({ agentId: "main", path: target.path });
  }
  const deletion = (sessionKey: string) =>
    deleteSessionEntryLifecycle({
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
    const write = replaceSessionEntry(writer, {
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
    await replaceSessionEntry(history, {
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
    await replaceSessionEntry(mixed, {
      ...entry,
      sessionId: "mixed-owned-current",
      previousSessionId: mixed.sessionId,
      pluginOwnerId: "memory-core",
    });
    await expect(cleanup({ pluginOwnerId: "memory-core" })).resolves.toEqual({
      removedEntries: 2,
      archivedTranscriptArtifacts: 0,
    });
    expect(loadSessionEntry(owned)).toBeUndefined();
    expect(loadSessionEntry(legacy)).toBeUndefined();
    expect(loadSessionEntry(foreign)).toMatchObject({ pluginOwnerId: "other-plugin" });
    await expect(loadTranscriptEvents(history)).resolves.toEqual([event]);
    expect(
      db.db
        .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
        .get(placeholder.sessionKey),
    ).toEqual({ current_session_id: placeholder.sessionId });
    await expect(loadTranscriptEvents(placeholder)).resolves.toEqual([event]);
    expect(loadSessionEntry(mixed)).toMatchObject({
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
    await replaceSessionEntry(history, { sessionId: "researcher-current", updatedAt: now });
    await expect(cleanup({ agentId: "main", pluginOwnerId: "memory-core" })).resolves.toEqual({
      removedEntries: 1,
      archivedTranscriptArtifacts: 0,
    });
    expect(loadSessionEntry(main)).toBeUndefined();
    expect(loadSessionEntry(foreign)).toMatchObject({ sessionId: foreign.sessionId });
    await expect(loadTranscriptEvents(history)).resolves.toEqual([historyEvent]);
  });

  it("revalidates entries before deleting their transcript state", async () => {
    const event = transcript("cleanup-race-session");
    const target = await seed(event.id, {}, [event]);
    const db = database();
    const refreshed = { label: "refreshed", sessionId: target.sessionId, updatedAt: now + 1 };
    let changed = false;
    hooks.after = () =>
      runOpenClawAgentWriteAdmission({ agentId: "main", path: db.path }, () => {
        changed = true;
        db.db
          .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
          .run(JSON.stringify(refreshed), refreshed.updatedAt, target.sessionKey);
      });
    await expect(cleanup({ orphanTranscriptMinAgeMs: 0, nowMs: now + 60_000 })).rejects.toThrow(
      "SQLite lifecycle cleanup entry changed",
    );
    expect(changed).toBe(true);
    expect(loadSessionEntry(target)).toEqual(refreshed);
    await expect(loadTranscriptEvents(target)).resolves.toEqual([event]);
  });

  it("releases the store writer while a historical generation is archived", async () => {
    const target = await seed("historical-race-current", {}, [
      transcript("historical-race-current"),
    ]);
    await replaceTranscriptEvents({ ...target, sessionId: "historical-race-unplanned" }, [
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

  it("releases the store writer while a lifecycle mutation archives a transcript", async () => {
    const target = await seed("lifecycle-race-archived-session", {}, [
      transcript("lifecycle-race-archived-session"),
    ]);
    const expectedEntry = loadSessionEntry(target);
    if (!expectedEntry) {
      throw new Error("expected persisted lifecycle removal entry");
    }
    await expect(
      writerDuringArchive(() =>
        applySessionEntryLifecycleMutation({
          storePath,
          removals: [
            { sessionKey: target.sessionKey, expectedEntry, archiveRemovedTranscript: true },
          ],
          skipMaintenance: true,
        }),
      ),
    ).resolves.toMatchObject({ removedEntries: 1, removedSessionKeys: [target.sessionKey] });
  });

  it("retains committed maintenance counts when archive publication fails", async () => {
    const target = await seed("maintenance-publication-failed", { updatedAt: 1 }, undefined, {
      sessionKey: "agent:main:subagent:maintenance-publication-failed",
    });
    hooks.publicationFailure = new Error("injected archive publication failure");
    const result = await applySessionEntryLifecycleMutation({
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
    expect(loadSessionEntry(target)).toBeUndefined();
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
    await replaceTranscriptEvents({ ...historyOwner, sessionId: historyId }, [
      transcript(historyId),
    ]);
    const batchSizes: number[] = [];
    let currentBatch: string[] = [];
    let materializations = 0;
    let racedKey: string | undefined;
    hooks.observe = (ids) => {
      currentBatch = ids;
      batchSizes.push(ids.length);
    };
    hooks.after = () => {
      if (++materializations !== 2) {
        return;
      }
      racedKey = sessions.find((session) => session.sessionId === currentBatch[0])?.sessionKey;
      if (!racedKey) {
        throw new Error("expected entry in the second batch");
      }
      const current = loadSessionEntry({ sessionKey: racedKey, storePath });
      if (!current) {
        throw new Error("expected raced entry");
      }
      replaceSessionEntrySync(
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
    const result = await applySessionEntryLifecycleMutation({
      storePath,
      maintenanceOverride: { mode: "enforce", maxEntries: entryCount, pruneAfterMs: 60_000 },
    });
    expect(batchSizes).toEqual([64, 2]);
    expect(published).not.toContain(racedKey);
    expect(published).toHaveLength(64);
    expect(result).toMatchObject({
      beforeCount: entryCount,
      afterCount: 2,
      modelRunPruned: 0,
      pruned: 64,
      capped: 0,
    });
    expect(loadSessionEntry({ sessionKey: racedKey ?? "", storePath })).toMatchObject({
      label: "changed during batch materialization",
    });
    expect(loadSessionEntry(sessions.at(-1)!)).toBeDefined();
    await expect(
      loadTranscriptEvents({ ...historyOwner, sessionId: historyId }),
    ).resolves.toHaveLength(0);
    expect(
      database()
        .db.prepare("SELECT 1 AS present FROM session_nodes WHERE session_key = ?")
        .get(historyOwner.sessionKey),
    ).toBeDefined();
  });
});
