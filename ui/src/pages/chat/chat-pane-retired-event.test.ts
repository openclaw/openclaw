/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import * as chatSendActions from "./chat-send-actions.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { admitStoredChatComposerQueueItemResult } from "./composer-queue-persistence.ts";
import { getChatSessionProjection } from "./history-merge.ts";

beforeEach(() => {
  installTranscriptDomMocks();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(resetTranscriptTestDom);

it.each([
  ["session.message", true],
  ["sessions.changed", true],
  ["session.message", false],
  ["sessions.changed", false],
] as const)(
  "a retired %s frame recovers stored input with its target pane mounted=%s",
  async (event, targetMounted) => {
    const successor: GatewaySessionRow = {
      key: "agent:main:retained-background",
      agentId: "main",
      sessionId: "successor-session",
      kind: "direct",
      updatedAt: 20,
      label: "Current successor",
      hasActiveRun: true,
      status: "running",
    };
    const foreground: GatewaySessionRow = {
      key: "agent:main:foreground",
      agentId: "main",
      sessionId: "foreground-session",
      kind: "direct",
      updatedAt: 1,
      hasActiveRun: false,
      status: "done",
    };
    const successorTranscript = [
      {
        role: "assistant",
        content: "Only the successor's accepted transcript belongs here",
        __openclaw: { id: "successor-history", seq: 1 },
      },
    ];
    const runId = "persisted-successor-input";
    let acknowledgeReplay = false;
    const history = vi.fn<GatewayRequestHandler>((_method, raw): ChatHistoryResult => {
      const params = asOptionalRecord(raw);
      const row = params?.sessionKey === successor.key ? successor : foreground;
      return {
        messages: row === successor ? successorTranscript : [],
        sessionId: row.sessionId,
        sessionInfo: row,
      };
    });
    const send = vi.fn<GatewayRequestHandler>(() => {
      if (!acknowledgeReplay) {
        throw new Error("gateway closed");
      }
      return { status: "ok", runId, messageSeq: 1 };
    });
    const fixture = createMountedPanes([foreground, successor], "main", undefined, {
      "chat.history": history,
      "chat.send": send,
      "chat.startup": history,
    });
    const { sessions, mount, emitGatewayEvent } = fixture;
    const resume = vi.spyOn(chatSendActions, "resumeStoredChatOutboxes");
    await sessions.refresh({ agentId: "main", force: true });
    const visiblePane = mount(foreground.key);
    const retainedPane = targetMounted ? mount(successor.key) : null;
    await Promise.all([visiblePane, ...(retainedPane ? [retainedPane] : [])].map(refreshPane));
    if (retainedPane) {
      retainedPane.presented = false;
      retainedPane.active = false;
    }
    const state = retainedPane?.state ?? visiblePane.state;
    const observedRow = retainedPane ? successor : foreground;
    const observedTranscript = retainedPane ? successorTranscript : [];
    function expectCurrentSession() {
      expect(state.currentSessionId).toBe(observedRow.sessionId);
      expect(getChatSessionProjection(state).scope.sessionId).toBe(observedRow.sessionId);
      expect(selectedChatSessionRow(state)).toMatchObject(observedRow);
      expect(state.chatMessages).toEqual(observedTranscript);
    }
    expectCurrentSession();
    const input: ChatQueueItem = {
      id: "stored-successor-input",
      sessionKey: successor.key,
      sessionId: successor.sessionId,
      sendRunId: runId,
      sendAttempts: 1,
      sendState: "waiting-reconnect",
      text: "Consumed input awaiting its receipt",
      createdAt: 1,
    };
    expect(
      admitStoredChatComposerQueueItemResult(
        visiblePane.state,
        captureChatOutboxAdmission(visiblePane.state, successor.key),
        input,
      ),
    ).toBe("admitted");
    // An interrupted replay retains the original input until the Gateway acknowledges it.
    await chatSendActions.resumeStoredChatOutboxes(visiblePane.state);
    expect(listStoredChatOutboxes(visiblePane.state)).toEqual([
      expect.objectContaining({
        sessionKey: successor.key,
        queue: [expect.objectContaining({ ...input, sendAttempts: 2 })],
      }),
    ]);
    const messagesBefore = state.chatMessages;
    expect(send).toHaveBeenCalledTimes(1);
    for (const mock of [history, resume, send]) {
      mock.mockClear();
    }
    acknowledgeReplay = true;

    emitGatewayEvent(event, {
      sessionKey: successor.key,
      agentId: "main",
      sessionId: "retired-predecessor-session",
      session: {
        ...successor,
        sessionId: "retired-predecessor-session",
        updatedAt: 10,
        label: "Retired predecessor",
        hasActiveRun: false,
        status: "done",
      },
      ancestorSessions: [],
      ...(event === "session.message"
        ? {
            messageId: "retired-predecessor-message",
            messageSeq: 99,
            message: {
              role: "user",
              content: "Retired predecessor content",
              __openclaw: { id: "retired-predecessor-message", seq: 99 },
            },
          }
        : { reason: "reset" }),
    });

    expect(resume).toHaveBeenCalledWith(
      visiblePane.state,
      expect.objectContaining({
        event,
        payload: expect.objectContaining({ sessionKey: successor.key }),
      }),
    );
    // Recovery must not hide a transient stale append or reset.
    expect(state.chatMessages).toBe(messagesBefore);
    expectCurrentSession();
    await Promise.all(
      resume.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : [])),
    );
    expect(listStoredChatOutboxes(visiblePane.state)).toEqual([]);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: successor.key,
        sessionId: successor.sessionId,
        message: input.text,
        idempotencyKey: runId,
      }),
      expect.anything(),
    );
    expect(history).not.toHaveBeenCalled();
    expectCurrentSession();
    expect(visiblePane.state.chatMessages).toEqual([]);
  },
);
