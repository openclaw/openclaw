/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { getChatSessionProjection, reduceChatSessionProjection } from "./history-merge.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each(
  (["event", "list"] as const).flatMap((admission) =>
    (["live predecessor", "live run", "live stream", "empty", "optimistic-only"] as const).map(
      (transcript) => ({ admission, transcript }),
    ),
  ),
)(
  "keeps $admission successor admission scoped before first history arrives: $transcript",
  async ({ admission, transcript }) => {
    const previous: GatewaySessionRow = {
      key: "agent:main:unidentified-live-transcript",
      agentId: "main",
      sessionId: "predecessor-session",
      kind: "direct",
      updatedAt: 1,
    };
    const successor = { ...previous, sessionId: "successor-session", updatedAt: 2 };
    const predecessorMessage = {
      role: "user",
      content: "Predecessor input received while its first history is pending",
      __openclaw: { id: "predecessor-live", seq: 1 },
    };
    const nextPredecessorMessage = {
      role: "user",
      content: "Another message for the same incarnation before its first history",
      __openclaw: { id: "predecessor-live-next", seq: 2 },
    };
    const successorMessage = {
      role: "user",
      content: "Successor input belongs to another physical transcript",
      __openclaw: { id: "successor-live", seq: 1, idempotencyKey: "initial-send:user" },
    };
    const initialHistory = createDeferred<ChatHistoryResult>();
    void initialHistory.promise.catch(() => undefined);
    const historyEntered = createDeferred();
    const successorHistory = createDeferred<ChatHistoryResult>();
    let successorExists = false;
    const history = () => {
      if (successorExists) {
        return successorHistory.promise;
      }
      historyEntered.resolve();
      return initialHistory.promise;
    };
    let listedRows: GatewaySessionRow[] = [];
    const { sessions, mount, emitGatewayEvent } = createMountedPanes(
      [previous],
      "main",
      undefined,
      {
        "sessions.list": () => sessionsResult(listedRows, 2),
        "chat.history": history,
        "chat.startup": history,
      },
    );
    let reading: ReturnType<typeof refreshPane> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(previous.key);
      reading = refreshPane(pane);
      await historyEntered.promise;
      // A separate scoped metadata read may finish before the transcript request.
      expect(sessions.captureReconcile()(previous, undefined, { resultAgentId: "main" })).toBe(
        true,
      );
      expect(selectedChatSessionRow(pane.state)).toMatchObject(previous);
      expect(pane.state.currentSessionId ?? null).toBeNull();

      if (transcript === "live predecessor") {
        emitGatewayEvent("session.message", {
          sessionKey: previous.key,
          agentId: "main",
          sessionId: previous.sessionId,
          messageId: "predecessor-live",
          messageSeq: 1,
          message: predecessorMessage,
          session: previous,
          ancestorSessions: [],
        });
        // Existing live content must not block the next same-incarnation message.
        emitGatewayEvent("session.message", {
          sessionKey: previous.key,
          agentId: "main",
          sessionId: previous.sessionId,
          messageId: "predecessor-live-next",
          messageSeq: 2,
          message: nextPredecessorMessage,
          session: previous,
          ancestorSessions: [],
        });
        expect(pane.state.chatMessages).toEqual([
          expect.objectContaining(predecessorMessage),
          expect.objectContaining(nextPredecessorMessage),
        ]);
      } else if (transcript === "live run" || transcript === "live stream") {
        const text = transcript === "live stream" ? "Predecessor is still working." : "";
        emitGatewayEvent("chat", {
          sessionKey: previous.key,
          agentId: "main",
          runId: "predecessor-live-run",
          seq: 1,
          state: "delta",
          deltaText: text,
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
        expect(pane.state.chatRunId).toBe("predecessor-live-run");
        expect(pane.state.chatStream).toBe(text);
        expect(getChatSessionProjection(pane.state).entries).toEqual([]);
      } else if (transcript === "optimistic-only") {
        reduceChatSessionProjection(pane.state, {
          type: "sendPending",
          runId: "initial-send",
          message: {
            role: "user",
            content: successorMessage.content,
            __openclaw: { idempotencyKey: "initial-send:user" },
          },
        });
        expect(getChatSessionProjection(pane.state).entries).toEqual([
          expect.objectContaining({ pending: true }),
        ]);
      } else {
        expect(pane.state.chatMessages).toEqual([]);
      }
      expect(pane.state.currentSessionId ?? null).toBeNull();
      const displayed = pane.state.chatMessages;
      const activeRun = pane.state.chatRunId;
      const stream = pane.state.chatStream;
      successorExists = true;
      if (admission === "list") {
        listedRows = [successor];
        await sessions.refresh({ agentId: "main", force: true });
        expect(selectedChatSessionRow(pane.state)).toMatchObject(successor);
        expect(pane.state.currentSessionId ?? null).toBeNull();
      }
      emitGatewayEvent("session.message", {
        sessionKey: successor.key,
        agentId: "main",
        sessionId: successor.sessionId,
        messageId: "successor-live",
        messageSeq: 1,
        message: successorMessage,
        session: successor,
        ancestorSessions: [],
      });
      expect(selectedChatSessionRow(pane.state)).toMatchObject(successor);
      if (
        transcript === "live predecessor" ||
        transcript === "live run" ||
        transcript === "live stream"
      ) {
        expect.soft(pane.state.chatMessages).toBe(displayed);
        expect.soft(pane.state.chatRunId).toBe(activeRun);
        expect.soft(pane.state.chatStream).toBe(stream);
        if (transcript === "live predecessor") {
          expect(pane.state.chatMessages).toEqual([
            expect.objectContaining(predecessorMessage),
            expect.objectContaining(nextPredecessorMessage),
          ]);
        } else {
          expect(pane.state.chatMessages).toEqual([]);
        }
      } else {
        expect(pane.state.chatMessages).toEqual([expect.objectContaining(successorMessage)]);
        expect(getChatSessionProjection(pane.state).entries.every((entry) => !entry.pending)).toBe(
          true,
        );
      }
    } finally {
      // The Gateway refuses A's held history after its selected session changes.
      initialHistory.reject(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "session changed while reading history; reload the conversation",
        }),
      );
      successorHistory.resolve({
        messages: [successorMessage],
        sessionId: successor.sessionId,
        sessionInfo: successor,
      });
      await reading;
      await vi.dynamicImportSettled();
    }
  },
);
