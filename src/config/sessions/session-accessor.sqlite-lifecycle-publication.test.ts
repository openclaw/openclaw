import { statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { retainCachedOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-scope.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config.js";
import { planSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-delete-snapshot.js";
import {
  isPreparedSessionSharingChange,
  projectSessionSharingEntry,
  readCommittedSessionEntryCache,
  readSessionEntryCache,
  retainPreparedSessionGenerationFacts,
  retainPreparedSessionSharingFacts,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  loadSessionEntry,
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import type { SqliteSessionReclamationPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { loadTranscriptEvents } from "./session-transcript-events.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "./session-transcript-reconcile.js";

const failures = vi.hoisted(() => ({
  publication: undefined as Error | undefined,
}));

vi.mock("./session-accessor.sqlite-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-identity.js")>();
  return {
    ...actual,
    publishCommittedSessionIdentity: (
      ...args: Parameters<typeof actual.publishCommittedSessionIdentity>
    ) => {
      if (failures.publication) {
        throw failures.publication;
      }
      return actual.publishCommittedSessionIdentity(...args);
    },
    prepareLifecycleIdentityPublication: (
      ...args: Parameters<typeof actual.prepareLifecycleIdentityPublication>
    ) => {
      const publish = actual.prepareLifecycleIdentityPublication(...args);
      return () => {
        if (failures.publication) {
          throw failures.publication;
        }
        publish();
      };
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  resetConfigRuntimeState();
  const config = { session: { maintenance: { mode: "warn" as const } } };
  setRuntimeConfigSnapshot(config, config);
});

afterEach(async () => {
  failures.publication = undefined;
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
});

it("publishes history changes only after deletion while fresh reads observe sibling protection", async () => {
  const stateDir = tempDirs.make("session-history-publication-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const sessionKey = "agent:main:history-publication";
  const sessionId = "history-publication-old";
  const scope = { agentId: "main", storePath: database.path, sessionKey, sessionId };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  const events = [
    {
      id: "retained-event",
      type: "message",
      message: { role: "user", content: "retained history" },
    },
  ];
  await replaceTranscriptEvents(scope, events);
  const successor = { sessionId: "history-publication-current", updatedAt: 2 };
  replaceSessionEntrySync(scope, successor);
  await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
  // Warm the unpinned native reader before a separate connection changes protection.
  expect(loadSessionEntryReadOnly(scope)).toMatchObject(successor);
  const prepared = planSessionStateDeleteIfUnreferenced({
    archiveDirectory: stateDir,
    archiveTranscript: false,
    database,
    referencedSessionIds: new Set(),
    sessionId,
  });
  if (!prepared) {
    throw new Error("Expected an unreferenced historical generation");
  }
  const plan = {
    kind: "history-eviction",
    databaseOptions: resolveSessionReclamationDatabaseOptions({
      agentId: "main",
      path: database.path,
    }),
    diskBudget: { preserveRecentMs: 7 * 24 * 60 * 60 * 1000 },
    materializedPlans: [{ ...prepared, archive: null, archivedTranscript: null }],
    protectedSessionIds: [],
    sessionId,
  } satisfies SqliteSessionReclamationPlan;
  const completed: boolean[] = [];
  const reclaim = () =>
    runSqliteSessionReclamation({
      forceInProcess: false,
      plan,
      onWorkerResult(result) {
        if (result.kind === "history-eviction") {
          completed.push(result.value.deleted);
        }
      },
    });
  const changes: SessionRowChange[] = [];
  const stop = sessionChanges.subscribeFacts((change) => {
    if ("sessionKey" in change && change.sessionKey === sessionKey) {
      changes.push(change);
    }
  });
  const peer = openNodeSqliteDatabase(database.path);
  const writeProtection = (updatedAt: number) => {
    peer.exec("BEGIN IMMEDIATE");
    try {
      peer
        .prepare("UPDATE session_nodes SET updated_at = ?, entry_json = ? WHERE session_key = ?")
        .run(
          updatedAt,
          JSON.stringify({ ...successor, updatedAt, label: "sibling protection" }),
          sessionKey,
        );
      peer
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(sessionKey);
      peer.exec("COMMIT");
    } catch (error) {
      peer.exec("ROLLBACK");
      throw error;
    }
  };
  try {
    const updatedAt = Date.now();
    writeProtection(updatedAt);
    await expect(reclaim()).resolves.toMatchObject({
      kind: "history-eviction",
      value: { deleted: false },
    });
    expect(completed).toEqual([false]);
    expect(changes).toEqual([]);
    expect(loadSessionEntryReadOnly(scope)).toMatchObject({
      ...successor,
      updatedAt,
      label: "sibling protection",
    });
    await expect(loadTranscriptEvents(scope)).resolves.toEqual(events);

    writeProtection(2);
    await expect(reclaim()).resolves.toMatchObject({
      kind: "history-eviction",
      value: { deleted: true },
    });
    expect(completed).toEqual([false, true]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ sessionKey, factsInvalidated: true });
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
    expect(loadSessionEntryReadOnly(scope)).toMatchObject({
      ...successor,
      label: "sibling protection",
    });
  } finally {
    stop();
    peer.close();
  }
});

it.each(["publication", "writer return", "rollback"] as const)(
  "records the committed lifecycle before %s settlement",
  async (outcome) => {
    const stateDir = tempDirs.make("session-lifecycle-publication-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:lifecycle-publication",
    };
    const entry = { sessionId: "committed-session", updatedAt: 1, label: "Committed row" };
    const failure = new Error(`synthetic ${outcome} failure`);
    failures.publication = outcome === "publication" ? failure : undefined;
    const events: string[] = [];
    const committed = vi.fn(() => {
      expect(database.db.isTransaction).toBe(false);
      expect(loadSessionEntryReadOnly(scope)).toMatchObject(entry);
      events.push("committed");
    });
    const unsubscribe = onSessionIdentityMutation((mutation) => {
      if (mutation.kind === "create" && mutation.current.sessionKeys.includes(scope.sessionKey)) {
        events.push("published");
      }
    });
    try {
      const operation = applySessionEntryLifecycleMutation({
        agentId: scope.agentId,
        storePath: scope.storePath,
        upserts: [{ sessionKey: scope.sessionKey, entry }],
        skipMaintenance: true,
        onLifecycleCommitted: committed,
        withCommit:
          outcome === "writer return"
            ? async (run) => {
                // Fail after the real commit, publication, and writer release have settled.
                await run(() => {});
                throw failure;
              }
            : undefined,
        ...(outcome === "rollback"
          ? {
              afterUpsertsInTransaction: () => {
                throw failure;
              },
            }
          : {}),
      });
      await expect(operation).rejects.toBe(failure);
      expect(committed).toHaveBeenCalledTimes(outcome === "rollback" ? 0 : 1);
      expect(events).toEqual(
        outcome === "rollback"
          ? []
          : outcome === "publication"
            ? ["committed"]
            : ["committed", "published"],
      );
      if (outcome === "rollback") {
        expect(loadSessionEntryReadOnly(scope)).toBeUndefined();
      } else {
        expect(loadSessionEntryReadOnly(scope)).toMatchObject(entry);
      }
    } finally {
      unsubscribe();
    }
  },
);

it("publishes removal invalidations before identity and row observers without archive intent", async () => {
  const stateDir = tempDirs.make("session-lifecycle-removal-publication-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const storePath = path.join(stateDir, "sessions.json");
  const scope = {
    sessionId: "session-1",
    sessionKey: "agent:main:preserve",
    storePath,
  };
  await upsertSessionEntryCore(scope, {
    restartRecoveryDeliveryContext: {
      channel: "whatsapp",
      to: "+15551234567",
    },
    restartRecoveryDeliveryRunId: "old-run",
    sessionId: scope.sessionId,
    updatedAt: 10,
  });
  const owner = { id: "lifecycle-owner", type: "human" as const };
  assignSessionOwner(scope, { assignedBy: owner, owner });
  await replaceTranscriptEvents(scope, [
    {
      id: "event-1",
      message: { role: "user", content: "keep me" },
      type: "message",
    },
  ]);

  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
  const identity = readOpenClawAgentDatabaseIdentity(database).identity;
  const entry = loadSessionEntry(scope);
  if (typeof identity !== "string" || !entry) {
    throw new Error("Expected a persisted lifecycle removal fixture");
  }
  const reader = retainCachedOpenClawAgentDatabaseReadOnly({ agentId: "main", path: target.path });
  if (!reader.found) {
    throw new Error("Expected a retained lifecycle reader");
  }
  const sharingEntry = projectSessionSharingEntry(entry);
  const sharing = retainPreparedSessionSharingFacts({
    databaseIdentity: `file:${identity}`,
    sessionKey: scope.sessionKey,
    entry: sharingEntry,
    membership: new Set(["member"]),
  });
  const acquiring = retainPreparedSessionSharingFacts({
    databaseIdentity: `file:${identity}`,
    sessionKey: scope.sessionKey,
    acquiring: true,
  });
  const generation = retainPreparedSessionGenerationFacts({
    databaseIdentity: `file:${identity}`,
    sessionKey: scope.sessionKey,
    entry: sharingEntry,
  });
  readSessionEntryCache(database, { cache: true });
  readSessionEntryCache(reader.database, { cache: true });
  expect(readCommittedSessionEntryCache(database.db)?.has(scope.sessionKey)).toBe(true);
  expect(readCommittedSessionEntryCache(reader.database.db)?.has(scope.sessionKey)).toBe(true);
  expect(sharing.readCurrent()?.entry).toEqual(sharingEntry);
  expect(generation.readCurrent()).toEqual(sharingEntry);
  const order: string[] = [];
  const readFacts = () => ({
    sharing: sharing.readCurrent(),
    generation: generation.readCurrent(),
    writableCache: readCommittedSessionEntryCache(database.db),
    readOnlyCache: readCommittedSessionEntryCache(reader.database.db),
  });
  const observedFacts: Array<
    ReturnType<typeof readFacts> & { invalidated: boolean; ownerTagged: boolean }
  > = [];
  const stopFacts = sessionChanges.subscribeFacts((change) => {
    if (!("sessionKey" in change) || change.sessionKey !== scope.sessionKey) {
      return;
    }
    order.push("facts");
    observedFacts.push({
      invalidated: change.factsInvalidated === true,
      ownerTagged: isPreparedSessionSharingChange(change),
      ...readFacts(),
    });
  });
  const stopProjection = sessionChanges.subscribeProjection((change) => {
    if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
      order.push("projection");
    }
  });
  const notify = vi.fn();
  const stopIdentity = onSessionIdentityMutation((mutation) => {
    notify(mutation);
    if (mutation.kind === "delete" && mutation.previous.sessionKeys.includes(scope.sessionKey)) {
      order.push("identity");
    }
  });
  const rowPaths: Array<string | undefined> = [];
  const stopRows = sessionChanges.subscribe((change) => {
    if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
      rowPaths.push(change.storePath);
      order.push("row");
    }
  });
  const lifecycleFacts: Array<ReturnType<typeof readFacts>> = [];
  try {
    const result = await applySessionEntryLifecycleMutation({
      storePath,
      onLifecycleCommitted: () => {
        order.push("committed");
        lifecycleFacts.push(readFacts());
      },
      removals: [{ expectedSessionId: scope.sessionId, sessionKey: scope.sessionKey }],
    });
    const file = statSync(target.path, { bigint: true });
    expect(result.removedEntries).toBe(1);
    expect(notify).toHaveBeenCalledWith({
      agentId: "main",
      databaseIdentity: `${file.dev}:${file.ino}`,
      kind: "delete",
      previous: { sessionId: scope.sessionId, sessionKeys: [scope.sessionKey] },
    });
    expect(order).toEqual(["facts", "projection", "committed", "identity", "row"]);
    expect(rowPaths).toEqual([database.path]);
    const retiredFacts = {
      sharing: undefined,
      generation: null,
      writableCache: undefined,
      readOnlyCache: undefined,
    };
    expect(lifecycleFacts).toEqual([retiredFacts]);
    expect(observedFacts).toEqual([{ invalidated: true, ownerTagged: true, ...retiredFacts }]);
    expect(() =>
      acquiring.initialize({ entry: sharingEntry, membership: new Set(["member"]) }),
    ).toThrow("Session sharing acquisition is no longer current");
    expect(result.archivedTranscriptDirectories).toEqual([]);
    expect(loadSessionEntry(scope)).toBeUndefined();
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
  } finally {
    stopFacts();
    stopProjection();
    stopIdentity();
    stopRows();
    sharing.release();
    acquiring.release();
    generation.release();
    reader.claim.release();
  }
});
