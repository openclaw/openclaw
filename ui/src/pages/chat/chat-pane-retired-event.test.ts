/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { listQuestionPrompts } from "../../app/question-prompt.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import * as chatSendActions from "./chat-send-actions.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { buildItems } from "./chat-thread.test-support.ts";
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

function session(name: string, updatedAt: number, running = false): GatewaySessionRow {
  return {
    key: `agent:main:${name}`,
    agentId: "main",
    sessionId: `${name}-session`,
    kind: "direct" as const,
    updatedAt,
    hasActiveRun: running,
    status: running ? "running" : "done",
  };
}

it.each([
  ["session.message", true],
  ["sessions.changed", true],
  ["session.message", false],
  ["sessions.changed", false],
] as const)(
  "a retired %s frame recovers stored input with its target pane mounted=%s",
  async (event, targetMounted) => {
    const successor = { ...session("retained-background", 20, true), label: "Current successor" };
    const foreground = session("foreground", 1);
    const successorTranscript = [
      {
        role: "assistant",
        content: "Only the successor's accepted transcript belongs here",
        __openclaw: { id: "successor-history", seq: 1 },
      },
    ];
    const runId = "persisted-successor-input";
    const history = vi.fn<GatewayRequestHandler>((_method, raw): ChatHistoryResult => {
      const row = asOptionalRecord(raw)?.sessionKey === successor.key ? successor : foreground;
      return {
        messages: row === successor ? successorTranscript : [],
        sessionId: row.sessionId,
        sessionInfo: row,
      };
    });
    const send = vi.fn<GatewayRequestHandler>(() => ({ status: "ok", runId, messageSeq: 1 }));
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
    const messagesBefore = state.chatMessages;
    history.mockClear();

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

it("a cursor reset to a reset transcript hides earlier question summaries and notices", async () => {
  const row = session("reset-rows", 1);
  let transcript: unknown[] = [{ role: "user", content: "Deploy", timestamp: 500 }];
  const history = vi.fn<GatewayRequestHandler>((_method, params) =>
    asOptionalRecord(params)?.cursor
      ? { kind: "reset" }
      : { messages: transcript, sessionId: row.sessionId, sessionInfo: row, deltaCursor: "c" },
  );
  const { sessions, mount, emitGatewayEvent } = createMountedPanes([row], "main", undefined, {
    "chat.history": history,
    "chat.startup": history,
  });
  await sessions.refresh({ agentId: "main", force: true });
  const pane = mount(row.key);
  await refreshPane(pane);
  const askAndAnswer = (id: string, ts: number) => {
    const target = { sessionKey: row.key, agentId: "main", runId: id };
    emitGatewayEvent("question.requested", {
      ...target,
      id,
      createdAtMs: ts,
      expiresAtMs: Date.now() + 60_000,
      status: "pending",
      questions: [{ questionId: "target", header: "Target", question: id, options: [] }],
    });
    emitGatewayEvent("question.resolved", {
      id,
      status: "answered",
      answers: { answers: { target: ["Staging"] } },
    });
    emitGatewayEvent("agent", {
      ...target,
      seq: 1,
      ts,
      stream: "notice",
      data: { phase: "warning", message: "Session observer assessments stopped" },
    });
  };
  // Notices ride the lazily loaded live-event runtime.
  const expectRows = (rows: string[]) =>
    vi.waitFor(() =>
      expect(
        buildItems({
          sessionKey: row.key,
          messages: pane.state.chatMessages,
          guardianNotices: pane.state.guardianNotices,
          questionPrompts: listQuestionPrompts(pane.questionPromptState),
        }).flatMap((item) =>
          item.kind === "question" ? [item.questionId] : item.kind === "notice" ? ["notice"] : [],
        ),
      ).toEqual(rows),
    );
  askAndAnswer("before-reset", 1_000);
  await expectRows(["notice", "before-reset"]);

  transcript = [
    { role: "system", content: "", timestamp: 2_000, __openclaw: { id: "r", kind: "reset" } },
    { role: "user", content: "/reset", timestamp: 2_000 },
  ];
  await refreshPane(pane);
  expect(history).toHaveBeenCalledWith(
    "chat.history",
    expect.objectContaining({ cursor: "c" }),
    expect.anything(),
  );
  await expectRows([]);
  askAndAnswer("after-reset", 3_000);

  await expectRows(["notice", "after-reset"]);
});
