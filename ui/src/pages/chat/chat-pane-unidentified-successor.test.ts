/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import * as transcriptDom from "./components/chat-transcript.test-support.ts";
import { getChatSessionProjection, reduceChatSessionProjection } from "./history-merge.ts";

beforeEach(transcriptDom.installTranscriptDomMocks);
afterEach(transcriptDom.resetTranscriptTestDom);

function makeMessage(id: string, seq: number, idempotencyKey?: string) {
  return {
    role: "user",
    content: id,
    __openclaw: { id, seq, ...(idempotencyKey ? { idempotencyKey } : {}) },
  };
}

it.each(
  (["event", "list"] as const).flatMap((admission) =>
    (["live predecessor", "live stream", "empty", "optimistic-only"] as const).map(
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
    const predecessors = [1, 2].map((seq) => makeMessage(`predecessor-${seq}`, seq));
    const successorMessage = makeMessage("successor-live", 1, "initial-send:user");
    const expectedMessages = predecessors.map((item) => expect.objectContaining(item));
    const initialHistory = createDeferred<ChatHistoryResult>();
    void initialHistory.promise.catch(() => undefined);
    const historyEntered = createDeferred();
    const successorHistory = createDeferred<ChatHistoryResult>();
    let currentHistory = initialHistory.promise;
    const history = () => {
      historyEntered.resolve();
      return currentHistory;
    };
    let listedRows: GatewaySessionRow[] = [];
    const responses = {
      "sessions.list": () => sessionsResult(listedRows, 2),
      "chat.history": history,
      "chat.startup": history,
    };
    const fixture = createMountedPanes([previous], "main", undefined, responses);
    const { sessions, mount, emitGatewayEvent } = fixture;
    const emitMessage = (row: GatewaySessionRow, message: ReturnType<typeof makeMessage>) =>
      emitGatewayEvent("session.message", {
        sessionKey: row.key,
        agentId: "main",
        sessionId: row.sessionId,
        messageId: message["__openclaw"].id,
        messageSeq: message["__openclaw"].seq,
        message,
        session: row,
        ancestorSessions: [],
      });
    let reading: ReturnType<typeof refreshPane> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(previous.key);
      const { state } = pane;
      reading = refreshPane(pane);
      await historyEntered.promise;
      const reconcile = sessions.captureReconcile();
      expect(reconcile(previous, undefined, { resultAgentId: "main" })).toBe(true);
      expect(selectedChatSessionRow(state)).toMatchObject(previous);
      expect(state.currentSessionId ?? null).toBeNull();

      if (transcript === "live predecessor") {
        for (const message of predecessors) {
          emitMessage(previous, message);
        }
        expect(state.chatMessages).toEqual(expectedMessages);
      } else if (transcript === "live stream") {
        const text = "Predecessor is still working.";
        emitGatewayEvent("chat", {
          sessionKey: previous.key,
          agentId: "main",
          runId: "predecessor-live-run",
          seq: 1,
          state: "delta",
          deltaText: text,
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
        await vi.waitFor(() =>
          expect(state).toMatchObject({ chatRunId: "predecessor-live-run", chatStream: text }),
        );
        expect(getChatSessionProjection(state).entries).toEqual([]);
      } else if (transcript === "optimistic-only") {
        reduceChatSessionProjection(state, {
          type: "sendPending",
          runId: "initial-send",
          message: {
            ...successorMessage,
            __openclaw: { idempotencyKey: "initial-send:user" },
          },
        });
        expect(getChatSessionProjection(state)).toMatchObject({ entries: [{ pending: true }] });
      } else {
        expect(state.chatMessages).toEqual([]);
      }
      expect(state.currentSessionId ?? null).toBeNull();
      const { chatMessages: displayed, chatRunId: activeRun, chatStream: stream } = state;
      currentHistory = successorHistory.promise;
      if (admission === "list") {
        listedRows = [successor];
        await sessions.refresh({ agentId: "main", force: true });
        expect(selectedChatSessionRow(state)).toMatchObject(successor);
        expect(state.currentSessionId ?? null).toBeNull();
      }
      emitMessage(successor, successorMessage);
      expect(selectedChatSessionRow(state)).toMatchObject(successor);
      if (transcript === "live predecessor" || transcript === "live stream") {
        expect.soft(state.chatMessages).toBe(displayed);
        expect.soft(state).toMatchObject({ chatRunId: activeRun, chatStream: stream });
        expect(state.chatMessages).toEqual(
          transcript === "live predecessor" ? expectedMessages : [],
        );
      } else {
        expect(state.chatMessages).toEqual([expect.objectContaining(successorMessage)]);
        expect(getChatSessionProjection(state).entries.some((entry) => entry.pending)).toBe(false);
      }
    } finally {
      // The Gateway refuses A's held history after its selected session changes.
      initialHistory.reject(
        new GatewayRequestError({ code: "UNAVAILABLE", message: "session changed while reading" }),
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
