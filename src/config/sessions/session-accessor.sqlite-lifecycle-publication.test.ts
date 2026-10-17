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
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config.js";
import { planSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-delete-snapshot.js";
import {
  isPreparedSessionSharingChange,
  projectSessionSharingEntry,
  readSessionEntryCache,
  retainPreparedSessionGenerationFacts,
  retainPreparedSessionSharingFacts,
} from "./session-accessor.sqlite-entry-cache.js";
import { readCommittedSessionEntryCache } from "./session-accessor.sqlite-entry-cache.test-support.js";
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
import { loadSessionTranscriptEvents as loadTranscriptEvents } from "./session-transcript-events.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "./session-transcript-reconcile.js";

const failures = vi.hoisted(() => ({ publication: undefined as Error | undefined }));

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
const transcript = [
  { id: "event", type: "message", message: { role: "user", content: "history" } },
];

function setup(name: string) {
  const stateDir = tempDirs.make(`session-${name}-`);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  return {
    stateDir,
    database,
    scope: { agentId: "main", storePath: database.path, sessionKey: `agent:main:${name}` },
  };
}

function committedCache(database: Pick<ReturnType<typeof openOpenClawAgentDatabase>, "db">) {
  return readCommittedSessionEntryCache(requireNativeSqliteDatabase(database.db));
}

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
  const { stateDir, database, scope: base } = setup("history-publication");
  const { sessionKey } = base;
  const sessionId = "history-publication-old";
  const scope = { ...base, sessionId };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  await replaceTranscriptEvents(scope, transcript);
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
    peer
      .prepare(`UPDATE session_nodes
      SET updated_at = ?, entry_json = ?, entry_valid = 1 WHERE session_key = ?`)
      .run(
        updatedAt,
        JSON.stringify({ ...successor, updatedAt, label: "sibling protection" }),
        sessionKey,
      );
  };
  try {
    for (const [updatedAt, deleted] of [
      [Date.now(), false],
      [2, true],
    ] as const) {
      writeProtection(updatedAt);
      await expect(reclaim()).resolves.toMatchObject({
        kind: "history-eviction",
        value: { deleted },
      });
      expect(completed).toEqual(deleted ? [false, true] : [false]);
      expect(changes).toMatchObject(deleted ? [{ sessionKey, factsInvalidated: true }] : []);
      expect(loadSessionEntryReadOnly(scope)).toMatchObject({
        ...successor,
        updatedAt,
        label: "sibling protection",
      });
      await expect(loadTranscriptEvents(scope)).resolves.toEqual(deleted ? [] : transcript);
    }
  } finally {
    stop();
    peer.close();
  }
});

it.each(["publication", "writer return", "rollback"] as const)(
  "records the committed lifecycle before %s settlement",
  async (outcome) => {
    const { database, scope } = setup("lifecycle-publication");
    const entry = { sessionId: "committed-session", updatedAt: 1, label: "Committed row" };
    const owner = { actor: { type: "human" as const, id: "lifecycle-creator" }, assignedAt: 1 };
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
        creation: {
          preparedTranscript: {
            sessionKey: scope.sessionKey,
            sessionId: entry.sessionId,
            events: transcript,
          },
          ownerAssignment: { sessionKey: scope.sessionKey, owner },
        },
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
        beforeCommitInTransaction:
          outcome === "rollback"
            ? () => {
                throw failure;
              }
            : undefined,
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
        expect(loadSessionEntryReadOnly(scope)).toMatchObject({ ...entry, owner });
      }
      await expect(loadTranscriptEvents({ ...scope, sessionId: entry.sessionId })).resolves.toEqual(
        outcome === "rollback" ? [] : transcript,
      );
    } finally {
      unsubscribe();
    }
  },
);

it("publishes confirmed removals before identity and row observers without archive intent", async () => {
  const stateDir = tempDirs.make("session-lifecycle-removal-publication-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const storePath = path.join(stateDir, "sessions.json");
  const scope = { sessionId: "session-1", sessionKey: "agent:main:preserve", storePath };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
  const owner = { id: "lifecycle-owner", type: "human" as const };
  assignSessionOwner(scope, { assignedBy: owner, owner });
  await replaceTranscriptEvents(scope, transcript);

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
  const factScope = { databaseIdentity: `file:${identity}`, sessionKey: scope.sessionKey };
  const sharing = retainPreparedSessionSharingFacts({
    ...factScope,
    entry: sharingEntry,
    membership: new Set(["member"]),
  });
  const acquiring = retainPreparedSessionSharingFacts({ ...factScope, acquiring: true });
  const generation = retainPreparedSessionGenerationFacts({ ...factScope, entry: sharingEntry });
  const connections = [database, reader.database];
  for (const connection of connections) {
    readSessionEntryCache(connection, { cache: true });
  }
  expect(
    connections.map((connection) => committedCache(connection)?.has(scope.sessionKey)),
  ).toEqual([true, true]);
  expect(sharing.readCurrent()?.entry).toEqual(sharingEntry);
  expect(generation.readCurrent()).toEqual(sharingEntry);
  const order: string[] = [];
  const readFacts = () => ({
    sharing: sharing.readCurrent(),
    generation: generation.readCurrent(),
    writableCache: committedCache(database),
    readOnlyCache: committedCache(reader.database),
  });
  const observedFacts: Array<
    ReturnType<typeof readFacts> & { invalidated: boolean; removed: boolean; ownerTagged: boolean }
  > = [];
  const stopFacts = sessionChanges.subscribeFacts((change) => {
    if (!("sessionKey" in change) || change.sessionKey !== scope.sessionKey) {
      return;
    }
    order.push("facts");
    observedFacts.push({
      invalidated: change.factsInvalidated === true,
      removed: change.facts?.kind === "removed",
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
    expect(result).toMatchObject({ removedEntries: 1, archivedTranscriptDirectories: [] });
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
    expect(observedFacts).toEqual([
      { invalidated: false, removed: true, ownerTagged: true, ...retiredFacts },
    ]);
    expect(() =>
      acquiring.initialize({ entry: sharingEntry, membership: new Set(["member"]) }),
    ).toThrow("Session sharing acquisition is no longer current");
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
