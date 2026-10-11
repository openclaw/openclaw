import { StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import {
  appendSessionTranscriptReport,
  appendTranscriptMessage,
  appendTranscriptMessages,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as projectionReads from "../../config/sessions/session-accessor.sqlite-projection-read.js";
import * as projectionWriter from "../../config/sessions/session-transcript-projection-writer.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import { historyLane } from "../../config/sessions/session-transcript-worker-resources.js";
import { onDiagnosticEvent, type DiagnosticEventPayload } from "../../infra/diagnostic-events.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SerializedJsonArray, serializeGatewayFrame } from "../serialized-json.js";
import {
  createPreparedSessionHistorySubagentProjection,
  prepareSessionHistoryDelta,
} from "../session-history-delta-visibility.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import type { RespondFn } from "./types.js";

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
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:writer-isolation",
      sessionId: "writer-isolation",
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(scope, {
      eventId: "committed-message",
      now: 1,
      message: { role: "user", content: "Committed needle", timestamp: 1 },
    });
    const context = await createHistoryReadContext();
    const request = async () => {
      const respond = vi.fn<RespondFn>();
      await chatHistoryHandlers["chat.history"]!({
        params: { sessionKey: scope.sessionKey },
        client: null,
        context,
        respond,
        req: { type: "req", id: "writer-isolation", method: "chat.history" },
        isWebchatConnect: () => false,
      });
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      return asOptionalRecord(respond.mock.calls[0]?.[1])?.messages;
    };
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
    const status = vi
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
      status.mockRestore();
    }
  });
});

it.each(["native", "acp"])(
  "keeps repeated cursor bytes and %s coordination visibility without request-thread transcript reads",
  async (sourceKind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:worker-delta",
        sessionId: "worker-delta",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const sourceSessionKey = `agent:main:${sourceKind === "native" ? "subagent" : "acp"}:worker`;
      if (sourceKind === "acp") {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: sourceSessionKey },
          {
            sessionId: "acp-worker",
            updatedAt: 1,
            spawnDepth: 0,
            parentSessionKey: scope.sessionKey,
          },
        );
        await upsertAcpSessionMeta({
          sessionKey: sourceSessionKey,
          agentId: "main",
          mutate: () => ({
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: sourceSessionKey,
            mode: "persistent",
            state: "idle",
            lastActivityAt: 2,
          }),
          now: () => 2,
        });
      }
      await appendTranscriptMessage(scope, {
        eventId: "question",
        now: 1,
        message: { role: "user", content: "Question", timestamp: 1 },
      });
      await appendTranscriptMessage(scope, {
        eventId: "coordination",
        now: 2,
        message: {
          role: "user",
          content: "Internal checkpoint",
          idempotencyKey: "worker-run:user",
          provenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceSessionKey,
          },
        },
      });
      const context = await createHistoryReadContext();
      const call = async (cursor?: string) => {
        const respond = vi.fn<RespondFn>();
        await chatHistoryHandlers["chat.history"]!({
          params: { sessionKey: scope.sessionKey, ...(cursor ? { cursor } : {}) },
          client: null,
          context,
          respond,
          req: { type: "req", id: "worker-delta", method: "chat.history" },
          isWebchatConnect: () => false,
        });
        const response = expectDefined(respond.mock.calls[0], "history response");
        expect(response[0]).toBe(true);
        return expectDefined(asOptionalRecord(response[1]), "history payload");
      };
      const initial = await call();
      const initialCounter = observeSqliteReadSql(StatementSync.prototype);
      try {
        const repeated = await call();
        expectHistoryThreadSql(initialCounter.queries);
        expect(repeated).toEqual({
          ...initial,
          sessionInfo: { ...asOptionalRecord(initial.sessionInfo), snapshotAt: expect.any(Number) },
        });
      } finally {
        initialCounter.restore();
      }
      if (typeof initial.deltaCursor !== "string") {
        throw new Error("Expected initial delta cursor");
      }
      await appendTranscriptMessage(scope, {
        eventId: "internal-answer",
        now: 3,
        message: {
          role: "assistant",
          content: "Internal response",
          __openclaw: { runId: "worker-run" },
        },
      });
      await appendSessionTranscriptReport(scope, {
        kind: "custom",
        customTypes: ["run-failed-before-reply"],
        selectReport: () => ({
          customType: "run-failed-before-reply",
          content: "Internal failure",
          display: true,
          details: { runId: "worker-run" },
        }),
      });
      await appendTranscriptMessage(scope, {
        eventId: "human-steer",
        now: 4,
        message: {
          role: "user",
          content: "Show me the result.",
          idempotencyKey: "human-steer:user",
          __openclaw: { steerTargetRunId: "worker-run" },
        },
      });
      await appendTranscriptMessage(scope, {
        eventId: "answer",
        now: 5,
        message: {
          role: "assistant",
          content: 'Escaped "answer" 🤖',
          timestamp: 5,
          __openclaw: { runId: "worker-run" },
        },
      });
      await appendTranscriptMessage(scope, {
        eventId: "ordinary-sibling",
        now: 6,
        message: { role: "assistant", content: "Ordinary sibling", timestamp: 6 },
      });
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      const projectionRead = vi.spyOn(projectionReads, "readCurrentProjectionSnapshot");
      const counter = observeSqliteReadSql(StatementSync.prototype);
      try {
        const firstDelta = await call(initial.deltaCursor);
        expect(firstDelta).toMatchObject({
          kind: "delta",
          messages: [
            { messageId: "human-steer" },
            { messageId: "answer" },
            { messageId: "ordinary-sibling" },
          ],
        });
        const firstJson = JSON.stringify(firstDelta);
        expect(firstJson).toContain(JSON.stringify('Escaped "answer" 🤖'));
        expect(JSON.stringify(await call(initial.deltaCursor))).toBe(firstJson);
        expectHistoryThreadSql(counter.queries);
        expect(projectionRead).not.toHaveBeenCalled();
      } finally {
        counter.restore();
        projectionRead.mockRestore();
        clock.mockRestore();
      }
    });
  },
);

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
  expect(prepared.subagentCoordination.runMessages).toHaveLength(200);
  expect(prepared.subagentCoordination.sessions).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify(prepared.subagentCoordination))).toBeLessThan(
    serializedBytes,
  );
  const follower = structuredClone(prepared);
  follower.subagentCoordination.runMessages[0]![2] = true;
  expect(prepared.subagentCoordination.runMessages[0]![2]).toBe(false);
});

it("forwards worker history as text JSON while preserving object callers and tiny budgets", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:encoded-history",
      sessionId: "encoded-history",
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await appendTranscriptMessages(scope, {
      messages: Array.from({ length: 3 }, (_, index) => ({
        eventId: `large-${index}`,
        now: index + 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `Synthetic ${index}: 🦞\n` + "x".repeat(48_000) }],
        },
      })),
    });
    const context = await createHistoryReadContext();
    const request = async (
      acceptsSerializedJson: boolean,
      maxBytes = 200_000,
      method = "chat.history",
      maxChars = 50_000,
    ) => {
      const respond = vi.fn<RespondFn>();
      await chatHistoryHandlers["chat.history"]!({
        params: { sessionKey: scope.sessionKey, maxChars, maxBytes },
        client: null,
        context,
        respond,
        acceptsSerializedJson,
        req: { type: "req", id: "encoded-history", method },
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      return expectDefined(asOptionalRecord(respond.mock.calls[0]?.[1]), "history payload");
    };
    const ordinary = await request(false);
    const encoded = await request(true);
    expect(encoded.messages).toBeInstanceOf(SerializedJsonArray);
    const materialize = vi.spyOn(SerializedJsonArray.prototype, "materialize");
    try {
      const frame = serializeGatewayFrame({ type: "res", payload: encoded });
      expect(Buffer.isBuffer(frame)).toBe(true);
      expect(materialize).not.toHaveBeenCalled();
      // Compare the durable page fields; session presentation carries a current clock.
      const decoded = JSON.parse(frame.toString()).payload;
      expect(decoded.messages).toEqual(ordinary.messages);
      for (const key of ["hasMore", "totalMessages", "nextOffset", "deltaCursor"]) {
        expect(decoded[key]).toEqual(ordinary[key]);
      }
      expect(Buffer.byteLength(JSON.stringify(decoded.messages))).toBeLessThanOrEqual(200_000);
    } finally {
      materialize.mockRestore();
    }
    expect(Array.isArray((await request(true, 200_000, "cron.history")).messages)).toBe(true);
    const small = await request(true, 200_000, "chat.history", 64);
    expect(small.messages).toBeInstanceOf(SerializedJsonArray);
    expect(
      JSON.parse(serializeGatewayFrame({ type: "res", payload: small }).toString()).payload
        .messages,
    ).toEqual((await request(false, 200_000, "chat.history", 64)).messages);
    const omissions: Extract<DiagnosticEventPayload, { type: "payload.large" }>[] = [];
    const stop = onDiagnosticEvent((event) => {
      if (event.type === "payload.large" && event.surface === "gateway.chat.history") {
        omissions.push(event);
      }
    });
    try {
      const tiny = await request(true, 1024);
      expect(tiny.messages).toBeInstanceOf(SerializedJsonArray);
      const messages = JSON.parse(serializeGatewayFrame({ type: "res", payload: tiny }).toString())
        .payload.messages;
      expect(messages).toMatchObject(
        Array.from({ length: 3 }, (_, index) => ({
          __openclaw: { id: `large-${index}`, truncated: true, reason: "oversized" },
        })),
      );
      expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThanOrEqual(1024);
      expect(tiny).not.toHaveProperty("omission");
      expect(omissions).toHaveLength(1);
      expect(omissions[0]).toMatchObject({ action: "truncated", count: 3, limitBytes: 1024 });
    } finally {
      stop();
    }
  });
});
