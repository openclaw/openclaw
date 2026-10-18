import type { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createReadonlySessionHistoryReader } from "../../gateway/session-history-readonly-reader.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import {
  OpenClawAgentDatabaseReadOnlyScope,
  withScopedOpenClawAgentDatabaseReadOnly,
} from "../../state/openclaw-agent-db-readonly-scope.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  appendTranscriptEvent,
  persistSessionTranscriptTurn,
  waitForSessionTranscriptProjection,
  type SessionTranscriptReadScope,
} from "./session-accessor.js";
import { readRecentSessionTranscriptHistoryEvents } from "./session-accessor.sqlite-history-events.test-support.js";
import {
  insertSyntheticHistory,
  readSessionTranscriptHistoryEventCount,
} from "./session-accessor.sqlite-history.test-support.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    cleanup();
  }),
);

beforeEach(() => setRuntimeConfigSnapshot({}));

function readHistoryWithQueryPlans(
  database: OpenClawAgentDatabase,
  scope: SessionTranscriptReadScope,
) {
  const nativeDb = requireNativeSqliteDatabase(database.db);
  clearNodeSqliteKyselyCacheForDatabase(nativeDb);
  const prepare = nativeDb.prepare.bind(nativeDb);
  const markerStatements: StatementSync[] = [];
  const anchorStatements: StatementSync[] = [];
  const spy = vi.spyOn(nativeDb, "prepare").mockImplementation((query) => {
    const statement = prepare(query);
    const columns = statement.columns().map(({ name }) => name);
    if (columns.includes("following_message_position")) {
      markerStatements.push(statement);
    }
    if (columns.length === 2 && columns.includes("event_id") && columns.includes("seq")) {
      anchorStatements.push(statement);
    }
    return statement;
  });
  try {
    const page = readRecentSessionTranscriptHistoryEvents(scope, {
      maxMessages: 20,
      maxLines: 20,
      maxBytes: 1_000_000,
    });
    expect(markerStatements.length).toBeLessThanOrEqual(1);
    const plan = markerStatements.flatMap((statement) =>
      prepare(`EXPLAIN QUERY PLAN ${statement.expandedSQL}`).all(),
    );
    const drivingSearch = plan.find(
      ({ detail }) => typeof detail === "string" && detail.startsWith("SEARCH "),
    )?.detail;
    const anchorSearches = anchorStatements.flatMap((statement) =>
      prepare(`EXPLAIN QUERY PLAN ${statement.expandedSQL}`)
        .all()
        .flatMap(({ detail }) =>
          typeof detail === "string" && detail.startsWith("SEARCH ") ? [detail] : [],
        ),
    );
    return { page, drivingSearch, anchorSearches };
  } finally {
    spy.mockRestore();
  }
}

it.each([false, true])("keeps history marker reads selective (analyzed=%s)", async (analyzed) => {
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-history-query-plan-") },
    sessionId: "history-events-test",
    sessionKey: "agent:main:history-events-test",
  };
  const denseScope = {
    ...scope,
    sessionId: "dense-marker-history",
    sessionKey: "agent:main:dense-marker-history",
  };
  const plainScope = {
    ...scope,
    sessionId: "plain-message-history",
    sessionKey: "agent:main:plain-message-history",
  };
  const compactionScope = {
    ...scope,
    sessionId: "dense-compaction-history",
    sessionKey: "agent:main:dense-compaction-history",
  };
  for (const target of [scope, denseScope, plainScope, compactionScope]) {
    await persistSessionTranscriptTurn(target, {
      messages: [transcriptMessage("seed", null, { role: "user", content: "seed" })],
      touchSessionEntry: false,
    });
  }
  const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
  const messageCount = 10_000;
  const markerIds = Array.from({ length: 10 }, (_, index) => `rare-marker-${index}`);
  insertSyntheticHistory(database, scope.sessionId, messageCount);
  // Session/type averages from the dense peer can favor scanning every active row
  // instead of selecting and sorting this session's few markers.
  insertSyntheticHistory(database, denseScope.sessionId, messageCount, true, "custom_message");
  insertSyntheticHistory(database, plainScope.sessionId, messageCount);
  insertSyntheticHistory(database, compactionScope.sessionId, messageCount / 2, true);
  let parentId = `synthetic-message-${messageCount + 1}`;
  for (const id of markerIds) {
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id,
      parentId,
      timestamp: "2026-09-13T00:00:00.000Z",
      summary: "sparse history marker",
    });
    parentId = id;
  }
  if (analyzed) {
    await waitForSessionTranscriptIndexReconcile(scope);
    database.db.exec("ANALYZE");
  }
  const { page, drivingSearch } = readHistoryWithQueryPlans(database, scope);
  const firstSequence = messageCount - markerIds.length + 2;
  expect(page.totalMessages).toBe(messageCount + markerIds.length + 1);
  expect(page.events.map(({ event }) => event)).toEqual(
    [
      ...Array.from({ length: 10 }, (_, index) => `synthetic-message-${firstSequence + index}`),
      ...markerIds,
    ].map((id) => expect.objectContaining({ id })),
  );
  expect(page.events.map(({ seq }) => seq)).toEqual(
    Array.from({ length: 20 }, (_, index) => firstSequence + index),
  );
  expect(drivingSearch).toMatch(/\(session_id=\? AND event_type=\?/u);

  const branchIds = Array.from({ length: 20 }, (_, index) => `branch-message-${index}`);
  async function readBranch(
    target: typeof scope,
    marker: { id: string; parentId: string } & (
      | { type: "compaction"; summary: string }
      | { type: "custom_message"; customType: string; content: string; display: boolean }
    ),
  ) {
    await appendTranscriptEvent(target, marker);
    await persistSessionTranscriptTurn(target, {
      messages: branchIds.map((id, index) =>
        transcriptMessage(id, index === 0 ? marker.id : branchIds[index - 1]!, {
          role: index % 2 === 0 ? "user" : "assistant",
          content: id,
        }),
      ),
      touchSessionEntry: false,
    });
    await waitForSessionTranscriptProjection(target);
    if (analyzed) {
      await waitForSessionTranscriptIndexReconcile(scope);
      database.db.exec("ANALYZE");
    }
    return readHistoryWithQueryPlans(database, target);
  }

  // The same stored markers must stop driving reads once their branch is inactive.
  const branch = await readBranch(denseScope, {
    type: "custom_message",
    id: "branch-marker",
    parentId: "seed",
    customType: "synthetic-notice",
    content: "Current branch marker",
    display: true,
  });
  expect(branch.page.totalMessages).toBe(22);
  expect(branch.page.events.map(({ event }) => event)).toEqual(
    branchIds.map((id) => expect.objectContaining({ id })),
  );
  expect(branch.page.events.map(({ seq }) => seq)).toEqual(
    Array.from({ length: 20 }, (_, index) => index + 3),
  );
  expect(branch.drivingSearch).toMatch(/^SEARCH active .*\(session_id=\?/u);
  expect(readSessionTranscriptHistoryEventCount(denseScope)).toBe(22);

  // Discarded ordinary messages do not justify scanning a branch with few markers.
  const sparseBranch = await readBranch(plainScope, {
    type: "compaction",
    id: "sparse-branch-marker",
    parentId: "seed",
    summary: "Current branch marker",
  });
  expect(sparseBranch.page.events.map(({ event }) => event)).toEqual(
    branchIds.map((id) => expect.objectContaining({ id })),
  );
  expect(sparseBranch.page.events.map(({ seq }) => seq)).toEqual(
    branch.page.events.map(({ seq }) => seq),
  );
  expect(sparseBranch.page.totalMessages).toBe(22);
  expect(sparseBranch.drivingSearch).toMatch(/\(session_id=\? AND event_type=\?/u);
  expect(readSessionTranscriptHistoryEventCount(plainScope)).toBe(22);
});

it("reads only appended metadata for a warm marker-heavy page and quoted messages", async () => {
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-history-incremental-") },
    sessionId: "incremental-history",
    sessionKey: "agent:main:incremental-history",
  };
  await persistSessionTranscriptTurn(scope, {
    messages: [transcriptMessage("seed", null, { role: "user", content: "seed" })],
    touchSessionEntry: false,
  });
  const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
  insertSyntheticHistory(database, scope.sessionId, 2_000, true);
  runOpenClawAgentWriteTransaction(
    (writeDatabase) => {
      writeDatabase.db
        .prepare(`UPDATE transcript_events
      SET navigation_type = NULL, navigation_custom_type = NULL,
          navigation_display = 0, message_role = NULL, navigation_last_type = NULL,
          navigation_last_custom_type = NULL, navigation_valid = 1
      WHERE session_id = ?`)
        .run(scope.sessionId);
    },
    { agentId: database.agentId, path: database.path },
  );
  const limits = { maxMessages: 3, maxLines: 3, maxBytes: 64 * 1024 };
  const target = {
    transcript: { ...scope, sessionFile: scope.sessionKey, storePath: database.path },
    database: { agentId: database.agentId, path: database.path },
  };
  const owner = new OpenClawAgentDatabaseReadOnlyScope();
  const reader = createReadonlySessionHistoryReader(target);
  const readPage = () =>
    owner.run(target.database, () =>
      reader.readHistoryEventPage({ ...limits, offset: 0, recentAtHead: limits }),
    );
  try {
    expect(readPage().totalMessages).toBe(4_001);
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("new-tail", "synthetic-message-4001", {
          role: "assistant",
          content: "New reply",
        }),
      ],
      touchSessionEntry: false,
    });
    const retained = owner.run(target.database, () =>
      withScopedOpenClawAgentDatabaseReadOnly(({ db }) => db, target.database),
    );
    if (!retained.found) {
      throw new Error("Expected the retained history reader");
    }
    const nativeDb = requireNativeSqliteDatabase(retained.value);
    const prototype: StatementSync = Object.getPrototypeOf(nativeDb.prepare("SELECT 1"));
    const executed = new Set<StatementSync>();
    const observers = (["all", "get", "iterate"] as const).map((method) => {
      const original = prototype[method];
      return vi.spyOn(prototype, method).mockImplementation(
        new Proxy(original, {
          apply(invoke, statement: StatementSync, args) {
            executed.add(statement);
            return Reflect.apply(invoke, statement, args);
          },
        }),
      );
    });
    const counter = trackSqliteStatementExecutions(nativeDb, ["read"], () => "read");
    try {
      const page = readPage();
      expect(page.totalMessages).toBe(4_002);
      expect(page.events.map(({ event }) => event)).toEqual(
        ["synthetic-boundary-4000", "synthetic-message-4001", "new-tail"].map((id) =>
          expect.objectContaining({ id }),
        ),
      );
      expect(page.events.map(({ seq }) => seq)).toEqual([4_000, 4_001, 4_002]);
      for (const seq of [3, 1_999, 3_999]) {
        expect(
          await owner.run(target.database, () =>
            reader.readSessionMessageByIdAsync(target.transcript, `synthetic-message-${seq}`),
          ),
        ).toMatchObject({ found: true, seq, message: { content: "synthetic" } });
      }
      expect(
        await owner.run(target.database, () =>
          reader.readSessionMessageByIdAsync(target.transcript, "synthetic-boundary-2000"),
        ),
      ).toMatchObject({ found: true, seq: 2_000 });
      // Bound transferred rows across both native execution methods, including cached statements.
      expect(counter.rowCounts.read).toBeGreaterThan(3);
      expect(counter.rowCounts.read).toBeLessThan(100);
    } finally {
      counter.restore();
      observers.forEach((observer) => observer.mockRestore());
    }
    const searches = [...executed].flatMap((statement) =>
      nativeDb
        .prepare(`EXPLAIN QUERY PLAN ${statement.expandedSQL}`)
        .all()
        .map(({ detail }) => detail),
    );
    expect(searches).toContainEqual(
      expect.stringMatching(/SEARCH event .*\(session_id=\? AND seq>\? AND seq<\?\)/u),
    );
    await appendTranscriptEvent(scope, {
      type: "custom_message",
      id: "branch",
      parentId: "seed",
      customType: "notice",
      content: "Different active branch",
      display: true,
    });
    await waitForSessionTranscriptProjection(scope);
    const branched = readPage();
    expect(branched.totalMessages).toBe(2);
    expect(branched.events.map(({ event }) => event)).toEqual(
      ["seed", "branch"].map((id) => expect.objectContaining({ id })),
    );
    expect(branched.events.map(({ seq }) => seq)).toEqual([1, 2]);
    expect(
      await owner.run(target.database, () =>
        reader.readSessionMessageByIdAsync(target.transcript, "synthetic-boundary-2000", {
          currentOnly: true,
          maxBytes: limits.maxBytes,
        }),
      ),
    ).toMatchObject({ found: false });
  } finally {
    owner.close();
  }
});

it("looks up nested activity anchors without scanning unrelated transcript identities", async () => {
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-history-anchors-") },
    sessionId: "history-anchors",
    sessionKey: "agent:main:history-anchors",
  };
  await persistSessionTranscriptTurn(scope, {
    messages: [transcriptMessage("seed", null, { role: "user", content: "seed" })],
    touchSessionEntry: false,
  });
  const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
  insertSyntheticHistory(database, scope.sessionId, 2_000);
  const anchors = ["seed", "seed", "missing"];
  await persistSessionTranscriptTurn(scope, {
    messages: anchors.map((afterEntryId, index) => ({
      eventId: `activity-${index}`,
      parentId: index === 0 ? "synthetic-message-2001" : `activity-${index - 1}`,
      message: createNestedToolActivity({
        runId: "run",
        scopeId: "attempt",
        afterEntryId,
        startOrder: index,
        parentToolCallId: "exec",
        toolCallId: `tool-${index}`,
        toolName: "read",
        input: {},
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
        startedAt: 1,
        timestamp: 2,
      }),
    })),
    touchSessionEntry: false,
  });
  const { page, anchorSearches } = readHistoryWithQueryPlans(database, scope);
  expect(
    page.events.slice(-3).map(({ displayPosition }) => displayPosition?.activity?.afterRawSeq),
  ).toEqual([1, 1, undefined]);
  expect(anchorSearches).toHaveLength(1);
  expect(anchorSearches[0]).toMatch(/\(session_id=\? AND event_id=\?\)/u);
});
