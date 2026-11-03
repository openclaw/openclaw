import assert from "node:assert/strict";
import { statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as admission from "../../infra/sqlite-database-admission.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { retainCachedOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-scope.js";
import * as agentDb from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config.js";
import { planSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-delete-snapshot.js";
import * as cache from "./session-accessor.sqlite-entry-cache.js";
import { readCommittedSessionEntryCache } from "./session-accessor.sqlite-entry-cache.test-support.js";
import {
  loadSessionEntry,
  loadSessionEntryReadOnly as readOnly,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import type { SqliteSessionReclamationPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import { applySessionEntryLifecycleMutation as mutate } from "./session-accessor.sqlite-projection.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { modelContextPageWriteScope } from "./session-model-context-pages.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { loadSessionTranscriptEvents as loadTranscriptEvents } from "./session-transcript-events.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "./session-transcript-reconcile.js";

const failures = vi.hoisted(() => ({ publication: undefined as Error | undefined }));

vi.mock("./session-accessor.sqlite-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-identity.js")>();
  const failPublication =
    <Args extends unknown[], Result>(run: (...args: Args) => Result) =>
    (...args: Args): Result => {
      if (failures.publication) {
        throw failures.publication;
      }
      return run(...args);
    };
  return {
    ...actual,
    publishCommittedSessionIdentity: failPublication(actual.publishCommittedSessionIdentity),
    prepareLifecycleIdentityPublication: (
      ...args: Parameters<typeof actual.prepareLifecycleIdentityPublication>
    ) => failPublication(actual.prepareLifecycleIdentityPublication(...args)),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const transcript = [
  { id: "event", type: "message", message: { role: "user", content: "history" } },
];

function setup(name: string) {
  const stateDir = tempDirs.make(`session-${name}-`);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const database = agentDb.openOpenClawAgentDatabase({ agentId: "main" });
  return {
    stateDir,
    database,
    scope: { agentId: "main", storePath: database.path, sessionKey: `agent:main:${name}` },
  };
}

function committedCache(
  database: Pick<ReturnType<typeof agentDb.openOpenClawAgentDatabase>, "db">,
) {
  return readCommittedSessionEntryCache(requireNativeSqliteDatabase(database.db));
}

beforeEach(() => {
  resetConfigRuntimeState();
  const config = { session: { maintenance: { mode: "warn" as const } } };
  setRuntimeConfigSnapshot(config, config);
});

afterEach(async () => {
  failures.publication = undefined;
  await agentDb.closeOpenClawAgentDatabasesAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
});

it("publishes history changes only after deletion while fresh reads observe sibling protection", async () => {
  const { stateDir, database, scope: base } = setup("history-publication");
  const { sessionKey } = base;
  const sessionId = "history-publication-old";
  const scope = { ...base, sessionId };
  const history = Array.from({ length: 513 }, (_, index) => ({
    ...transcript[0]!,
    id: `event-${index}`,
  }));
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  await replaceTranscriptEvents(scope, history);
  const successor = { sessionId: "history-publication-current", updatedAt: 2 };
  const pageScopes = [
    modelContextPageWriteScope(sessionId, 0),
    modelContextPageWriteScope(sessionId, 512),
    modelContextPageWriteScope(successor.sessionId, 0),
  ];
  admission.readSqliteDatabaseScopedWriteToken(database.db, pageScopes);
  // Deletion must also retire pages retained before the transcript became shorter.
  await replaceTranscriptEvents(scope, transcript);
  replaceSessionEntrySync(scope, successor);
  await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
  const retainedPageScopes = () => {
    const retained = admission.captureSqliteDatabaseAdmissions(undefined, {
      location: database.path,
    })[0];
    return pageScopes.map((key) =>
      retained?.writeScopes.some((bucket) =>
        bucket.has(JSON.stringify(["session-id", key.sessionId, key.partition])),
      ),
    );
  };
  expect(retainedPageScopes()).toEqual([true, true, true]);
  // Warm the unpinned native reader before a separate connection changes protection.
  expect(readOnly(scope)).toMatchObject(successor);
  const prepared = planSessionStateDeleteIfUnreferenced({
    archiveDirectory: stateDir,
    archiveTranscript: false,
    database,
    referencedSessionIds: new Set(),
    sessionId,
  });
  assert(prepared, "Expected an unreferenced historical generation");
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
  const reclaim = () => runSqliteSessionReclamation({ plan });
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
      expect(changes).toMatchObject(deleted ? [{ sessionKey, factsInvalidated: true }] : []);
      expect(readOnly(scope)).toMatchObject({
        ...successor,
        updatedAt,
        label: "sibling protection",
      });
      await expect(loadTranscriptEvents(scope)).resolves.toEqual(deleted ? [] : transcript);
      expect(retainedPageScopes()).toEqual(deleted ? [false, false, true] : [true, true, true]);
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
    const committed = () => {
      expect(database.db.isTransaction).toBe(false);
      expect(readOnly(scope)).toMatchObject(entry);
      events.push("committed");
    };
    const unsubscribe = onSessionIdentityMutation((mutation) => {
      if (mutation.kind === "create" && mutation.current.sessionKeys.includes(scope.sessionKey)) {
        events.push("published");
      }
    });
    try {
      const operation = mutate({
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
      expect(events).toEqual(
        outcome === "rollback"
          ? []
          : outcome === "publication"
            ? ["committed"]
            : ["committed", "published"],
      );
      if (outcome === "rollback") {
        expect(readOnly(scope)).toBeUndefined();
      } else {
        expect(readOnly(scope)).toMatchObject({ ...entry, owner });
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
  const database = agentDb.openOpenClawAgentDatabase({ agentId: "main", path: target.path });
  const identity = readOpenClawAgentDatabaseIdentity(database).identity;
  const entry = loadSessionEntry(scope);
  assert(typeof identity === "string" && entry, "Expected a persisted lifecycle removal fixture");
  const reader = retainCachedOpenClawAgentDatabaseReadOnly({ agentId: "main", path: target.path });
  assert(reader.found, "Expected a retained lifecycle reader");
  const sharingEntry = cache.projectSessionSharingEntry(entry);
  const factScope = { databaseIdentity: `file:${identity}`, sessionKey: scope.sessionKey };
  const sharing = cache.retainPreparedSessionSharingFacts({
    ...factScope,
    entry: sharingEntry,
    membership: new Set(["member"]),
  });
  const acquiring = cache.retainPreparedSessionSharingFacts({ ...factScope, acquiring: true });
  const generation = cache.retainPreparedSessionGenerationFacts({
    ...factScope,
    entry: sharingEntry,
  });
  for (const connection of [database, reader.database]) {
    cache.readSessionEntryCache(connection, { cache: true });
    expect(committedCache(connection)?.has(scope.sessionKey)).toBe(true);
  }
  expect([sharing.readCurrent()?.entry, generation.readCurrent()]).toEqual([
    sharingEntry,
    sharingEntry,
  ]);
  const observations: unknown[][] = [];
  const readFacts = () => [
    sharing.readCurrent(),
    generation.readCurrent(),
    committedCache(database),
    committedCache(reader.database),
  ];
  const forSession = (
    change: SessionRowChange,
  ): change is Extract<SessionRowChange, { sessionKey: string }> =>
    "sessionKey" in change && change.sessionKey === scope.sessionKey;
  const stopFacts = sessionChanges.subscribeFacts((change) => {
    if (!forSession(change)) {
      return;
    }
    observations.push([
      "facts",
      change.factsInvalidated === true,
      change.facts?.kind === "removed",
      cache.isPreparedSessionSharingChange(change),
      ...readFacts(),
    ]);
  });
  const stopProjection = sessionChanges.subscribeProjection((change) => {
    if (forSession(change)) {
      observations.push(["projection"]);
    }
  });
  const notify = vi.fn();
  const stopIdentity = onSessionIdentityMutation((mutation) => {
    notify(mutation);
    if (mutation.kind === "delete" && mutation.previous.sessionKeys.includes(scope.sessionKey)) {
      observations.push(["identity"]);
    }
  });
  const stopRows = sessionChanges.subscribe((change) => {
    if (forSession(change)) {
      observations.push(["row", change.storePath]);
    }
  });
  try {
    const result = await mutate({
      storePath,
      onLifecycleCommitted: () => {
        observations.push(["committed", ...readFacts()]);
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
    const retiredFacts = [undefined, null, undefined, undefined];
    expect(observations).toEqual([
      ["facts", false, true, true, ...retiredFacts],
      ["projection"],
      ["committed", ...retiredFacts],
      ["identity"],
      ["row", database.path],
    ]);
    expect(() =>
      acquiring.initialize({ entry: sharingEntry, membership: new Set(["member"]) }),
    ).toThrow("Session sharing acquisition is no longer current");
    expect(loadSessionEntry(scope)).toBeUndefined();
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
  } finally {
    for (const stop of [stopFacts, stopProjection, stopIdentity, stopRows]) {
      stop();
    }
    for (const retained of [sharing, acquiring, generation, reader.claim]) {
      retained.release();
    }
  }
});
