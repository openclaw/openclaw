import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  isSessionNodePayloadSelect,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission-state.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionLifecycleArtifactsCore } from "./session-accessor.sqlite-artifact-cleanup.js";
import { writeSessionEntry as writeRow } from "./session-accessor.sqlite-entry-store.js";
import { loadSessionEntryReadOnly as readEntry } from "./session-accessor.sqlite-entry.js";
import * as artifactPlanning from "./session-accessor.sqlite-lifecycle-artifacts.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import * as workerReaders from "./session-transcript-worker-readers.js";
import { promptReport } from "./system-prompt-report.test-support.js";
import type { SessionEntry } from "./types.js";

let state: OpenClawTestState;
let database: OpenClawAgentDatabase;
let storePath: string;
let options: { agentId: string; path: string; env: NodeJS.ProcessEnv };
const sessionKey = "agent:main:artifact-plan-victim";
const sessionId = "artifact-plan-victim";
const entry = { sessionId, updatedAt: 1 };
const event = { type: "metadata", runId: "artifact-plan-marker" };
const cleanupInput = () => ({
  sessionKeySegmentPrefix: "artifact-plan-",
  transcriptContentMarker: "artifact-plan-marker",
  orphanTranscriptMinAgeMs: 0,
  archiveRemovedEntryTranscripts: false,
});
const planInput = () => ({ ...cleanupInput(), archiveDirectory: state.sessionsDir() });
const writeEntry = (key: string, value: SessionEntry) =>
  runOpenClawAgentWriteTransaction((db) => writeRow(db, key, value), options);

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "artifact-planning-", layout: "state-only" });
  storePath = path.join(state.sessionsDir(), "sessions.json");
  database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  options = { agentId: "main", path: database.path, env: state.env };
  writeEntry(sessionKey, entry);
  await replaceTranscriptEvents({ storePath, sessionKey, sessionId }, [event]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await state.cleanup();
});

it("skips unused candidate reads and observes a later matching entry", () => {
  const input = {
    ...planInput(),
    agentId: "main",
    pluginOwnerId: "memory-core",
    sessionKeySegmentPrefix: "idle-cleanup-",
    orphanTranscriptMinAgeMs: 300_000,
    nowMs: Date.now() + 600_000,
  };
  const planWithReadCounts = () => {
    const reads = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["entryPayload", "foreignOwners"],
      (sql) => {
        if (isSessionNodePayloadSelect(sql)) {
          return "entryPayload";
        }
        return sql.startsWith(
          'select "session_id" from "session_windows" where "plugin_owner_id" is not null',
        ) && sql.includes('"plugin_owner_id" !=')
          ? "foreignOwners"
          : null;
      },
    );
    try {
      return {
        plan: artifactPlanning.planSessionLifecycleArtifactCleanup(database, input),
        reads: { ...reads.counts },
      };
    } finally {
      reads.restore();
    }
  };

  expect(planWithReadCounts()).toEqual({
    plan: { entries: [], deletePlans: [] },
    reads: { entryPayload: 0, foreignOwners: 0 },
  });

  const candidateKey = "agent:main:idle-cleanup-candidate";
  const candidate = {
    sessionId: "idle-cleanup-candidate",
    updatedAt: 1,
    pluginOwnerId: "memory-core",
  };
  writeEntry(candidateKey, candidate);
  const next = planWithReadCounts();
  expect(next.plan.entries).toHaveLength(1);
  expect(next.plan.entries).toMatchObject([{ sessionKey: candidateKey, expectedEntry: candidate }]);
  expect(next.plan.deletePlans.map((plan) => plan.sessionId)).toEqual([candidate.sessionId]);
  expect(next.reads).toEqual({ entryPayload: 1, foreignOwners: 1 });
});

it("hydrates only old scoped candidates while protecting out-of-scope history references", () => {
  const nowMs = Date.now() + 600_000;
  const snapshots = {
    sessionDiffBaseline: { version: 1, sessionId, root: "/synthetic", files: [] },
    skillsSnapshot: { prompt: "saved prompt".repeat(1024), skills: [] },
    systemPromptReport: promptReport(1, 1, 0),
  } satisfies Partial<SessionEntry>;
  const survivorReferences = {
    previousSessionId: "protected-previous",
    usageFamilySessionIds: ["protected-usage"],
    compactionCheckpoints: [
      {
        sessionId: "protected-checkpoint",
        preCompaction: { sessionId: "protected-pre" },
        postCompaction: { sessionId: "protected-post" },
      },
    ],
  };
  const expectedEntry = {
    ...entry,
    ...snapshots,
    ...survivorReferences,
    delivery: { kind: "none" as const },
  };
  runOpenClawAgentWriteTransaction((transaction) => {
    writeRow(transaction, sessionKey, expectedEntry);
    for (const [key, id, updatedAt, references] of [
      ["agent:main:survivor", "survivor", 1, survivorReferences],
      ["agent:main:artifact-plan-recent", "recent", nowMs, {}],
      ["agent:other:artifact-plan-victim", "other-agent", 1, {}],
    ] as const) {
      writeRow(transaction, key, {
        ...snapshots,
        ...references,
        sessionId: id,
        updatedAt,
      });
    }
  }, options);
  const hydratedKeys: unknown[] = [];
  requireNativeSqliteDatabase(database.db).function("artifact_snapshot_value", (key, valueJson) => {
    hydratedKeys.push(key);
    return valueJson;
  });
  database.db.exec(`CREATE TEMP VIEW session_entry_snapshots AS
    SELECT session_key, field, artifact_snapshot_value(session_key, value_json) AS value_json
    FROM main.session_entry_snapshots`);
  try {
    const plan = runSqliteDeferredTransactionSync(database.db, () =>
      artifactPlanning.planSessionLifecycleArtifactCleanup(database, {
        ...planInput(),
        agentId: "main",
        orphanTranscriptMinAgeMs: 300_000,
        nowMs,
      }),
    );
    expect(plan.entries).toEqual([{ sessionKey, expectedEntry }]);
    expect(plan.deletePlans.map((planned) => planned.sessionId)).toEqual([sessionId]);
    expect(hydratedKeys).toEqual([sessionKey, sessionKey, sessionKey]);
  } finally {
    database.db.exec("DROP VIEW temp.session_entry_snapshots");
  }
});

it.each(["admitted", "revoked", "referenced"] as const)(
  "preserves session state when a delayed artifact plan is %s",
  async (outcome) => {
    const reached = createDeferred();
    const release = createDeferred();
    let planReleased = false;
    const createReaders = workerReaders.createSessionHistoryWorkerReaders;
    vi.spyOn(workerReaders, "createSessionHistoryWorkerReaders").mockImplementation((run) =>
      createReaders(async (...args) => {
        const input = args[0]();
        const result = await run(...args);
        if (input.kind === "lifecycle-artifact-plan") {
          reached.resolve();
          await release.promise;
          planReleased = true;
        }
        return result;
      }),
    );
    const nativePlanning = vi
      .spyOn(artifactPlanning, "prepareSessionLifecycleArtifactCleanupForMaintenance")
      .mockRejectedValue(new Error("artifact planning ran on the calling thread"));
    const pending = cleanupSessionLifecycleArtifactsCore({ storePath, ...cleanupInput() });
    const settled = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let admission: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
    let closing: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
    let following: Promise<void> | undefined;
    try {
      await awaitGateBeforeSettlement(
        reached.promise,
        pending,
        "Artifact worker read was bypassed",
      );
      if (outcome === "admitted") {
        admission = await beginSessionEffect({
          scope: storePath,
          identities: [sessionKey, sessionId],
          assertAllowed: () => {},
        });
      } else if (outcome === "revoked") {
        closing = closeOpenClawAgentDatabaseByPathAsync(options.path);
      } else if (outcome === "referenced") {
        writeEntry("agent:main:survivor", {
          sessionId: "survivor",
          previousSessionId: sessionId,
          updatedAt: 2,
        });
        let followingEntered = false;
        following = runExclusiveSqliteSessionWrite(
          options,
          async () => {
            expect(planReleased).toBe(true);
            followingEntered = true;
          },
          "session.transcript.batch",
        );
        expect(
          SQLITE_SESSION_WRITER_QUEUES.get(fs.realpathSync(options.path))?.pending,
        ).toHaveLength(1);
        expect(followingEntered).toBe(false);
      }
      release.resolve();
      if (outcome === "referenced") {
        expect(await settled).toEqual({
          value: { removedEntries: 1, archivedTranscriptArtifacts: 0 },
        });
        expect(readEntry({ storePath, sessionKey: "agent:main:survivor" })).toMatchObject({
          previousSessionId: sessionId,
        });
      } else {
        const message = {
          admitted: "competing work is in flight",
          revoked: "revoked",
        }[outcome];
        expect(await settled).toMatchObject({
          error: { message: expect.stringContaining(message) },
        });
      }
      await closing;
      await following;
      expect(nativePlanning).not.toHaveBeenCalled();
      const retainedEntry = readEntry({ storePath, sessionKey });
      expect(retainedEntry).toEqual(
        outcome === "referenced" ? undefined : expect.objectContaining(entry),
      );
      expect(loadTranscriptEventsSync({ storePath, sessionId })).toEqual([event]);
    } finally {
      release.resolve();
      admission?.release();
      await settled;
      await closing;
      await following;
    }
  },
);

it("leaves a missing lifecycle store absent", async () => {
  const absent = { agentId: "missing", env: state.env };
  const databasePath = resolveOpenClawAgentSqlitePath(absent);
  expect(fs.existsSync(databasePath)).toBe(false);
  await expect(
    cleanupSessionLifecycleArtifactsCore({
      ...absent,
      storePath: path.join(state.sessionsDir("missing"), "sessions.json"),
      sessionKeySegmentPrefix: "artifact-plan-",
      transcriptContentMarker: "artifact-plan-marker",
      orphanTranscriptMinAgeMs: 0,
    }),
  ).resolves.toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 0 });
  expect(fs.existsSync(databasePath)).toBe(false);
});

it("pages orphan marker reads while protecting fresh and retained history", () => {
  const freshSessionId = "history-000";
  const unrelatedSessionId = "history-001";
  const marker = "artifact%_plan-marker";
  const ids = Array.from(
    { length: 129 },
    (_, index) => `history-${String(index).padStart(3, "0")}`,
  );
  runOpenClawAgentWriteTransaction((transaction) => {
    writeRow(transaction, sessionKey, { ...entry, previousSessionId: ids.at(-2) });
    const window = transaction.db.prepare(
      "INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, 1, 1)",
    );
    const transcript = transaction.db.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 0, ?, 1)",
    );
    for (const id of ids) {
      window.run(id, sessionKey);
      transcript.run(
        id,
        JSON.stringify({
          ...event,
          runId: id === unrelatedSessionId ? "artifactXXplan-marker" : marker,
        }),
      );
    }
  }, options);
  const reads = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["transcriptSelection"],
    (sql) =>
      sql.includes('from "transcript_events"') &&
      (sql.includes('max("created_at")') || sql.includes(' as "event_json"'))
        ? "transcriptSelection"
        : null,
  );
  const nowMs = Date.now();
  const plan = () =>
    artifactPlanning.planSessionLifecycleArtifactCleanup(database, {
      ...planInput(),
      transcriptContentMarker: marker,
      sessionKeySegmentPrefix: "unrelated-",
      orphanTranscriptMinAgeMs: 300_000,
      nowMs,
    });
  try {
    const first = plan();
    expect(database.db.isTransaction).toBe(false);
    expect(first.entries).toEqual([]);
    expect(first.deletePlans.map((item) => item.sessionId)).toEqual(
      ids.filter((id) => id !== unrelatedSessionId && id !== ids.at(-2)),
    );
    expect(reads.counts.transcriptSelection).toBe(2);

    // A later event must invalidate eligibility even when its payload has no marker.
    runOpenClawAgentWriteTransaction((transaction) => {
      transaction.db
        .prepare(
          "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 1, ?, ?)",
        )
        .run(freshSessionId, JSON.stringify({ type: "metadata" }), nowMs);
    }, options);
    expect(plan().deletePlans.map((item) => item.sessionId)).toEqual(
      ids.filter((id) => id !== freshSessionId && id !== unrelatedSessionId && id !== ids.at(-2)),
    );
    expect(reads.counts.transcriptSelection).toBe(4);
  } finally {
    reads.restore();
  }
});
