import { StatementSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import * as projectionReads from "../../config/sessions/session-accessor.sqlite-projection-read.js";
import * as projectionWriter from "../../config/sessions/session-transcript-projection-writer.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import { historyLane } from "../../config/sessions/session-transcript-worker-resources.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SerializedJsonArray } from "../serialized-json.js";
import {
  createPreparedSessionHistorySubagentProjection,
  prepareSessionHistoryDelta,
} from "../session-history-delta-visibility.js";
import {
  historyPayload,
  historyRpc,
  seedHistorySession,
} from "./chat-history-fixture.test-support.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";

type Scope = Awaited<ReturnType<typeof seedHistorySession>>;
function withHistory(id: string, run: (scope: Scope) => Promise<void>) {
  return withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    await run(await seedHistorySession(id));
  });
}
function append(
  scope: Scope,
  eventId: string,
  now: number,
  role: string,
  content: string,
  extra: Record<string, unknown> = {},
) {
  return appendTranscriptMessage(scope, { eventId, now, message: { role, content, ...extra } });
}
function observeReads() {
  const counter = observeSqliteReadSql(StatementSync.prototype);
  return { ...counter, [Symbol.dispose]: counter.restore };
}

function expectHistoryThreadSql(queries: string[]) {
  const isVersionProbe = (sql: string) =>
    /^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu.test(sql);
  // Pending-input reconciliation is still local; schema admission needs one freshness probe.
  expect(
    queries.filter((sql) => !isVersionProbe(sql) && !sql.includes('"session_pending_inputs"')),
  ).toEqual([]);
  expect(queries.filter(isVersionProbe).length).toBeLessThanOrEqual(1);
}

it("serves committed history while transcript searches wait on a stuck writer", async (test) => {
  await withHistory("writer-isolation", async (scope) => {
    await append(scope, "committed-message", 1, "user", "Committed needle", { timestamp: 1 });
    const rpc = historyRpc(await createHistoryReadContext(), scope.sessionKey);
    const request = async () => historyPayload(await rpc("chat.history")).messages;
    const committed = await request();
    expect(committed).toMatchObject([{ content: "Committed needle" }]);
    const writerEntered = createDeferred();
    const releaseWriter = createDeferred();
    const writer = runOpenClawAgentWorkerWrite({ agentId: "main" }, async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
    });
    const searchesEntered = createDeferred();
    const count = historyLane.pool.getSnapshot().maxWorkers;
    let entered = 0;
    const readStatus = projectionWriter.readSessionTranscriptIndexStatus;
    using _ = vi
      .spyOn(projectionWriter, "readSessionTranscriptIndexStatus")
      .mockImplementation((...args) => {
        if (++entered === count) {
          searchesEntered.resolve();
        }
        return readStatus(...args);
      });
    const searches: ReturnType<typeof searchSessionTranscripts>[] = [];
    let history: ReturnType<typeof request> | undefined;
    try {
      await withinTest(writerEntered.promise, test.signal);
      for (let index = 0; index < count; index++) {
        const search = searchSessionTranscripts({ ...scope, query: "needle" });
        void search.catch(() => {});
        searches.push(search);
      }
      await withinTest(searchesEntered.promise, test.signal);
      history = request();
      expect(await withinTest(history, test.signal)).toEqual(committed);
    } finally {
      releaseWriter.resolve();
      await writer;
      await Promise.allSettled([...searches, ...(history ? [history] : [])]);
    }
  });
});

it("keeps repeated cursor bytes without request-thread transcript reads", async () => {
  await withHistory("worker-delta", async (scope) => {
    await append(scope, "question", 1, "user", "Question", { timestamp: 1 });
    const rpc = historyRpc(await createHistoryReadContext(), scope.sessionKey);
    const call = async (cursor?: string) =>
      historyPayload(await rpc("chat.history", cursor ? { cursor } : {}));
    const initial = await call();
    {
      using initialCounter = observeReads();
      const repeated = await call();
      expectHistoryThreadSql(initialCounter.queries);
      expect(repeated).toEqual({
        ...initial,
        sessionInfo: { ...asOptionalRecord(initial.sessionInfo), snapshotAt: expect.any(Number) },
      });
    }
    if (typeof initial.deltaCursor !== "string") {
      throw new Error("Expected initial delta cursor");
    }
    await append(scope, "answer", 2, "assistant", 'Escaped "answer" 🤖', { timestamp: 2 });
    {
      using _ = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      using projectionRead = vi.spyOn(projectionReads, "readCurrentProjectionSnapshot");
      using counter = observeReads();
      const firstDelta = await call(initial.deltaCursor);
      expect(firstDelta).toMatchObject({
        kind: "delta",
        messages: [{ messageId: "answer" }],
      });
      const firstJson = JSON.stringify(firstDelta);
      expect(firstJson).toContain(JSON.stringify('Escaped "answer" 🤖'));
      expect(JSON.stringify(await call(initial.deltaCursor))).toBe(firstJson);
      expectHistoryThreadSql(counter.queries);
      expect(projectionRead).not.toHaveBeenCalled();
    }
  });
});

it("refuses missing or revoked visibility facts while retaining false and sequence-specific answers", () => {
  let current = true;
  const resolver = createPreparedSessionHistorySubagentProjection(
    {
      sessions: [["peer", false]],
      runMessages: [
        ["run", 2, true],
        ["run", 4, false],
      ],
    },
    () => {
      if (!current) {
        throw new Error("source revoked");
      }
    },
  );
  expect(resolver.isSubagentSession("peer")).toBe(false);
  expect(resolver.isSubagentRunMessage("run", 2)).toBe(true);
  expect(resolver.isSubagentRunMessage("run", 4)).toBe(false);
  expect(() => resolver.isSubagentSession("unknown")).toThrow("visibility is unavailable");
  expect(() => resolver.isSubagentRunMessage("run", 3)).toThrow("visibility is unavailable");
  current = false;
  expect(() => resolver.isSubagentRunMessage("run", 4)).toThrow("source revoked");
});

it("keeps transferred visibility proportional to the bounded delta, including cloned followers", () => {
  const events = Array.from({ length: 200 }, (_, index) => ({
    seq: index + 1,
    messageSeq: index + 1,
    event: {
      type: "message" as const,
      id: `message-${index}`,
      message: {
        role: "assistant",
        content: "reply",
        __openclaw: { runId: `${index}:${"🤖".repeat(400)}` },
      },
    },
  }));
  const serializedBytes = Buffer.byteLength(JSON.stringify(events));
  const prepared = prepareSessionHistoryDelta(
    {
      kind: "page",
      cursor: "cursor",
      hasMore: false,
      activeLeafEntryId: null,
      events,
      serializedBytes,
    },
    { isSubagentSession: () => false, isSubagentRunMessage: () => false },
  );
  expect(serializedBytes).toBeLessThan(1_000_000);
  expect(prepared.subagentCoordination.sessions).toEqual([]);
  expect(prepared.subagentCoordination.runMessages).toHaveLength(200);
  expect(Buffer.byteLength(JSON.stringify(prepared.subagentCoordination))).toBeLessThan(
    serializedBytes,
  );
  const follower = structuredClone(prepared);
  follower.subagentCoordination.runMessages[0]![2] = true;
  expect(prepared.subagentCoordination.runMessages[0]![2]).toBe(false);
});

it("serializes direct history calls but keeps object messages for method adapters", async () => {
  await withHistory("encoded-history", async (scope) => {
    await append(scope, "reply", 1, "assistant", "Object caller reply");
    const rpc = historyRpc(await createHistoryReadContext(), scope.sessionKey);
    expect(
      historyPayload(await rpc("chat.history", {}, { acceptsSerializedJson: true })).messages,
    ).toBeInstanceOf(SerializedJsonArray);
    const result = historyPayload(
      await rpc(
        "chat.history",
        {},
        {
          acceptsSerializedJson: true,
          req: { type: "req", id: "encoded-history", method: "cron.history" },
        },
      ),
    );
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages).toMatchObject([{ content: "Object caller reply" }]);
  });
});
