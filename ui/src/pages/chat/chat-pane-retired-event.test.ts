/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
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
import {
  admitStoredChatComposerQueueItem,
  listStoredChatOutboxes,
} from "./composer-persistence.ts";
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
    let consumed = false;
    const history = vi.fn<GatewayRequestHandler>((_method, raw): ChatHistoryResult => {
      const params = asOptionalRecord(raw);
      const row = params?.sessionKey === successor.key ? successor : foreground;
      return {
        messages: row === successor ? successorTranscript : [],
        sessionId: row.sessionId,
        sessionInfo: row,
        ...(row === successor && consumed
          ? { inputReceipts: [{ runId, state: "consumed", consumedByEventId: "persisted-user" }] }
          : {}),
      };
    });
    const {
      state: fixtureState,
      sessions,
      mount,
      emitGatewayEvent,
    } = createMountedPanes([foreground, successor], "main", undefined, {
      "chat.history": history,
      "chat.startup": history,
    });
    if (!fixtureState.client) {
      throw new Error("Mounted pane fixture must have a connected client");
    }
    const request = vi.spyOn(fixtureState.client, "request");
    const resume = vi.spyOn(chatSendActions, "resumeStoredChatOutboxes");
    await sessions.refresh({ agentId: "main", force: true });
    const visiblePane = mount(foreground.key);
    const retainedPane = targetMounted ? mount(successor.key) : null;
    await Promise.all([
      refreshPane(visiblePane),
      ...(retainedPane ? [refreshPane(retainedPane)] : []),
    ]);
    if (retainedPane) {
      retainedPane.presented = false;
      retainedPane.active = false;
    }
    const state = retainedPane?.state ?? visiblePane.state;
    const observedRow = retainedPane ? successor : foreground;
    const observedTranscript = retainedPane ? successorTranscript : [];
    expect(selectedChatSessionRow(state)).toMatchObject(observedRow);
    expect(state.currentSessionId).toBe(observedRow.sessionId);
    expect(state.chatMessages).toEqual(observedTranscript);
    const input: ChatQueueItem = {
      id: "stored-successor-input",
      sessionKey: successor.key,
      sessionId: successor.sessionId,
      sendRunId: runId,
      sendAttempts: 1,
      sendState: "waiting-reconnect",
      text: "Already consumed by the successor; the browser still needs its receipt",
      createdAt: 1,
    };
    expect(
      admitStoredChatComposerQueueItem(
        visiblePane.state,
        captureChatOutboxAdmission(visiblePane.state, successor.key),
        input,
      ),
    ).toBe(true);
    // Settle startup/admission recovery first: an active successor without a receipt stays queued.
    await chatSendActions.resumeStoredChatOutboxes(visiblePane.state);
    expect(listStoredChatOutboxes(visiblePane.state)).toEqual([
      expect.objectContaining({
        sessionKey: successor.key,
        queue: [expect.objectContaining(input)],
      }),
    ]);
    const messagesBefore = state.chatMessages;
    history.mockClear();
    request.mockClear();
    resume.mockClear();
    consumed = true;

    emitGatewayEvent(event, {
      sessionKey: successor.key,
      agentId: "main",
      sessionId: "retired-predecessor-session",
      session: {
        ...successor,
        sessionId: "retired-predecessor-session",
        updatedAt: 10,
        label: "Retired predecessor must not replace the current row",
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
              content: "Retired predecessor content must not enter the successor transcript",
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
    // A background history refresh must not hide a transient stale append or reset.
    expect(state.chatMessages).toBe(messagesBefore);
    expect(state.currentSessionId).toBe(observedRow.sessionId);
    expect(getChatSessionProjection(state).scope.sessionId).toBe(observedRow.sessionId);
    expect(selectedChatSessionRow(state)).toMatchObject(observedRow);
    await Promise.all(
      resume.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : [])),
    );
    expect(listStoredChatOutboxes(visiblePane.state)).toEqual([]);
    const recoveryCalls = history.mock.calls.filter(([, raw]) => {
      const ids = asOptionalRecord(raw)?.inputRunIds;
      return Array.isArray(ids) && ids.includes(runId);
    });
    expect(recoveryCalls).toEqual([
      ["chat.history", { sessionKey: successor.key, inputRunIds: [runId], limit: 1000 }, undefined],
    ]);
    expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    expect(state.chatMessages).toEqual(observedTranscript);
    expect(state.currentSessionId).toBe(observedRow.sessionId);
    expect(getChatSessionProjection(state).scope.sessionId).toBe(observedRow.sessionId);
    expect(selectedChatSessionRow(state)).toMatchObject(observedRow);
    expect(visiblePane.state.chatMessages).toEqual([]);
  },
);
