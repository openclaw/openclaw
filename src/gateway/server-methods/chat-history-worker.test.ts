import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import {
  appendSessionTranscriptReport,
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as deltaEvents from "../../config/sessions/session-accessor.sqlite-history-events.js";
import * as projectionReads from "../../config/sessions/session-accessor.sqlite-projection-read.js";
import type {
  SessionHistoryDelta,
  SessionHistoryWorkerRequest,
} from "../../config/sessions/session-history-types.js";
import * as historyWorker from "../../config/sessions/session-history-worker-runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createPreparedSessionHistorySubagentProjection,
  prepareSessionHistoryDelta,
} from "../session-history-delta-visibility.js";
import { createSessionHistorySubagentProjection } from "../session-history-subagent-projection.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import type { RespondFn } from "./types.js";

it.each(["native", "acp"])(
  "keeps cursor bytes and %s coordination visibility without request-thread transcript reads",
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
      try {
        const deltaReader: {
          readSessionHistoryPageInWorker(
            request: Extract<SessionHistoryWorkerRequest, { kind: "delta" }>,
          ): Promise<SessionHistoryDelta & { assertCurrent: () => void }>;
        } = historyWorker;
        const native = vi
          .spyOn(deltaReader, "readSessionHistoryPageInWorker")
          .mockImplementationOnce(async (request) => {
            const resolver = createSessionHistorySubagentProjection(request.params.target);
            return {
              ...prepareSessionHistoryDelta(
                deltaEvents.readTranscriptDisplayDelta(
                  request.params.target,
                  request.params.limits,
                ),
                resolver,
              ),
              assertCurrent: expectDefined(resolver.assertCurrent, "native source admission"),
            };
          });
        let golden: Record<string, unknown>;
        try {
          golden = await call(initial.deltaCursor);
        } finally {
          native.mockRestore();
        }
        expect(golden).toMatchObject({
          kind: "delta",
          messages: [
            { messageId: "human-steer" },
            { messageId: "answer" },
            { messageId: "ordinary-sibling" },
          ],
        });
        const goldenJson = JSON.stringify(golden);
        const read = vi.spyOn(deltaEvents, "readTranscriptDisplayDelta").mockImplementation(() => {
          throw new Error("Transcript SQLite read ran on the request thread");
        });
        const projectionRead = vi.spyOn(projectionReads, "readCurrentProjectionSnapshot");
        try {
          expect(JSON.stringify(await call(initial.deltaCursor))).toBe(goldenJson);
          expect(read).not.toHaveBeenCalled();
          expect(projectionRead).not.toHaveBeenCalled();
        } finally {
          projectionRead.mockRestore();
          read.mockRestore();
        }
      } finally {
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
