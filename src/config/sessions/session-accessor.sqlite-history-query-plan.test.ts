import type { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createReadonlySessionHistoryReader } from "../../gateway/session-history-readonly-reader.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import {
  OpenClawAgentDatabaseReadOnlyScope,
  withScopedOpenClawAgentDatabaseReadOnly,
} from "../../state/openclaw-agent-db-readonly-scope.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  appendTranscriptEvent,
  waitForSessionTranscriptProjection,
  type SessionTranscriptReadScope,
} from "./session-accessor.js";
import { readRecentSessionTranscriptHistoryEvents } from "./session-accessor.sqlite-history-events.test-support.js";
import {
  insertSyntheticHistory,
  historyActivity,
  clearHistoryNavigation,
  persistHistory,
  useHistoryEventScope,
} from "./session-accessor.sqlite-history.test-support.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

const fixtureScope = useHistoryEventScope();
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(clearRuntimeConfigSnapshot);

async function seedHistory(sessionId: string) {
  const scope = {
    ...fixtureScope,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
  };
  await seedTranscript(scope);
  const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
  return { scope, database };
}

async function seedTranscript(scope: Parameters<typeof persistHistory>[0]) {
  await persistHistory(scope, [transcriptMessage("seed", null, { role: "user", content: "seed" })]);
}

function expectPage(
  page: ReturnType<typeof readRecentSessionTranscriptHistoryEvents>,
  ids: string[],
  firstSequence: number,
  totalMessages: number,
) {
  expect(page.totalMessages).toBe(totalMessages);
  expect(page.events.map(({ seq, event }) => [seq, event])).toEqual(
    ids.map((id, index) => [firstSequence + index, expect.objectContaining({ id })]),
  );
}

type ObservedQuery = { columns: string[]; expandedSQL: string };

function observeQueries(nativeDb: ReturnType<typeof requireNativeSqliteDatabase>) {
  const prototype: StatementSync = Object.getPrototypeOf(nativeDb.prepare("SELECT 1"));
  const statements = new Map<StatementSync, ObservedQuery>();
  const observers = (["all", "get", "iterate"] as const).map((method) => {
    const original = prototype[method];
    return vi.spyOn(prototype, method).mockImplementation(
      new Proxy(original, {
        apply(invoke, statement: StatementSync, args) {
          const result = Reflect.apply(invoke, statement, args);
          // Snapshot bound metadata before the executor releases the native statement.
          statements.set(statement, {
            columns: statement.columns().map(({ name }) => name),
            expandedSQL: statement.expandedSQL,
          });
          return result;
        },
      }),
    );
  });
  return {
    statements,
    restore: () => observers.forEach((observer) => observer.mockRestore()),
    plans: (selected: Iterable<ObservedQuery> = statements.values()) =>
      [...selected].flatMap(({ expandedSQL }) =>
        nativeDb
          .prepare(`EXPLAIN QUERY PLAN ${expandedSQL}`)
          .all()
          .map(({ detail }) => detail),
      ),
  };
}

function readHistoryWithQueryPlans(
  database: OpenClawAgentDatabase,
  scope: SessionTranscriptReadScope,
) {
  const nativeDb = requireNativeSqliteDatabase(database.db);
  clearNodeSqliteKyselyCacheForDatabase(nativeDb);
  const observed = observeQueries(nativeDb);
  let page: ReturnType<typeof readRecentSessionTranscriptHistoryEvents>;
  try {
    page = readRecentSessionTranscriptHistoryEvents(scope, {
      maxMessages: 20,
      maxLines: 20,
      maxBytes: 1_000_000,
    });
  } finally {
    observed.restore();
  }
  const select = (matches: (columns: string[]) => boolean) =>
    [...observed.statements.values()].filter(({ columns }) => matches(columns));
  const markers = select((columns) => columns.includes("following_message_position"));
  const anchors = select(
    (columns) => columns.length === 2 && columns.includes("event_id") && columns.includes("seq"),
  );
  const searches = (statements: ObservedQuery[]) =>
    observed
      .plans(statements)
      .filter((detail) => typeof detail === "string" && detail.startsWith("SEARCH "));
  expect(markers.length).toBeLessThanOrEqual(1);
  return { page, drivingSearch: searches(markers)[0], anchorSearches: searches(anchors) };
}

it.each([false, true])("keeps history marker reads selective (analyzed=%s)", async (analyzed) => {
  const { scope, database } = await seedHistory("history-events-test");
  const sibling = (sessionId: string) => ({
    ...scope,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
  });
  const denseScope = sibling("dense-marker-history");
  const plainScope = sibling("plain-message-history");
  const compactionScope = sibling("dense-compaction-history");
  for (const target of [denseScope, plainScope, compactionScope]) {
    await seedTranscript(target);
  }
  const messageCount = 10_000;
  insertSyntheticHistory(database, scope.sessionId, messageCount);
  // Session/type averages from the dense peer can favor scanning every active row
  // instead of selecting and sorting this session's few markers.
  insertSyntheticHistory(database, denseScope.sessionId, messageCount, true, "custom_message");
  insertSyntheticHistory(database, plainScope.sessionId, messageCount);
  insertSyntheticHistory(database, compactionScope.sessionId, messageCount / 2, true);
  await appendTranscriptEvent(scope, {
    type: "compaction",
    id: "rare-marker",
    parentId: `synthetic-message-${messageCount + 1}`,
    summary: "sparse history marker",
  });
  if (analyzed) {
    await waitForSessionTranscriptIndexReconcile(scope);
    database.db.exec("ANALYZE");
  }
  const { drivingSearch } = readHistoryWithQueryPlans(database, scope);
  expect(drivingSearch).toMatch(/\(session_id=\? AND event_type=\?/u);

  const branchIds = Array.from({ length: 20 }, (_, index) => `branch-message-${index}`);
  async function readBranch(target: typeof scope, type: "compaction" | "custom_message") {
    const markerId = `${type}-branch-marker`;
    await appendTranscriptEvent(target, {
      type,
      id: markerId,
      parentId: "seed",
      ...(type === "compaction"
        ? { summary: "Current branch marker" }
        : { customType: "synthetic-notice", content: "Current branch marker", display: true }),
    });
    await persistHistory(
      target,
      branchIds.map((id, index) =>
        transcriptMessage(id, index === 0 ? markerId : branchIds[index - 1]!, {
          role: index % 2 === 0 ? "user" : "assistant",
          content: id,
        }),
      ),
    );
    await waitForSessionTranscriptProjection(target);
    if (analyzed) {
      await waitForSessionTranscriptIndexReconcile(scope);
      database.db.exec("ANALYZE");
    }
    return readHistoryWithQueryPlans(database, target);
  }

  // Neither inactive dense markers nor discarded ordinary messages should drive a sparse branch.
  for (const [target, type, search] of [
    [denseScope, "custom_message", /^SEARCH active .*\(session_id=\?/u],
    [plainScope, "compaction", /\(session_id=\? AND event_type=\?/u],
  ] as const) {
    const branch = await readBranch(target, type);
    expectPage(branch.page, branchIds, 3, 22);
    expect(branch.drivingSearch).toMatch(search);
  }
});

it("reads only appended metadata for a warm marker-heavy page and quoted messages", async () => {
  const { scope, database } = await seedHistory("incremental-history");
  insertSyntheticHistory(database, scope.sessionId, 2_000, true);
  runOpenClawAgentWriteTransaction(
    (writeDatabase) => clearHistoryNavigation(writeDatabase, scope.sessionId),
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
  const readMessage = (id: string, currentOnly = false) =>
    owner.run(target.database, () =>
      reader.readSessionMessageByIdAsync(
        target.transcript,
        id,
        currentOnly ? { currentOnly, maxBytes: limits.maxBytes } : undefined,
      ),
    );
  try {
    expect(readPage().totalMessages).toBe(4_001);
    await persistHistory(scope, [
      transcriptMessage("new-tail", "synthetic-message-4001", {
        role: "assistant",
        content: "New reply",
      }),
    ]);
    const retained = owner.run(target.database, () =>
      withScopedOpenClawAgentDatabaseReadOnly(({ db }) => db, target.database),
    );
    if (!retained.found) {
      throw new Error("Expected the retained history reader");
    }
    const nativeDb = requireNativeSqliteDatabase(retained.value);
    const observed = observeQueries(nativeDb);
    const counter = trackSqliteStatementExecutions(nativeDb, ["read"], () => "read");
    try {
      const page = readPage();
      expectPage(
        page,
        ["synthetic-boundary-4000", "synthetic-message-4001", "new-tail"],
        4_000,
        4_002,
      );
      for (const seq of [3, 1_999, 3_999]) {
        expect(await readMessage(`synthetic-message-${seq}`)).toMatchObject({
          found: true,
          seq,
          message: { content: "synthetic" },
        });
      }
      expect(await readMessage("synthetic-boundary-2000")).toMatchObject({
        found: true,
        seq: 2_000,
      });
      // Bound transferred rows across both native execution methods, including cached statements.
      expect(counter.rowCounts.read).toBeGreaterThan(3);
      expect(counter.rowCounts.read).toBeLessThan(100);
    } finally {
      counter.restore();
      observed.restore();
    }
    const searches = observed.plans();
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
    expectPage(readPage(), ["seed", "branch"], 1, 2);
    expect(await readMessage("synthetic-boundary-2000", true)).toMatchObject({ found: false });
  } finally {
    owner.close();
  }
});

it("looks up nested activity anchors without scanning unrelated transcript identities", async () => {
  const { scope, database } = await seedHistory("history-anchors");
  insertSyntheticHistory(database, scope.sessionId, 2_000);
  const anchors = ["seed", "seed", "missing"];
  await persistHistory(
    scope,
    anchors.map((afterEntryId, index) => ({
      eventId: `activity-${index}`,
      parentId: index === 0 ? "synthetic-message-2001" : `activity-${index - 1}`,
      message: historyActivity({
        afterEntryId,
        startOrder: index,
        toolCallId: `tool-${index}`,
      }),
    })),
  );
  const { page, anchorSearches } = readHistoryWithQueryPlans(database, scope);
  expect(
    page.events.slice(-3).map(({ displayPosition }) => displayPosition?.activity?.afterRawSeq),
  ).toEqual([1, 1, undefined]);
  expect(anchorSearches).toHaveLength(1);
  expect(anchorSearches[0]).toMatch(/\(session_id=\? AND event_id=\?\)/u);
});
