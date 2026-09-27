/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { getChatSessionProjection } from "./history-merge.ts";
import { readChatSessionSnapshot } from "./session-message-cache.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each(["branch-switch", "rewind"] as const)(
  "refreshes successor history when canonical admission follows the %s event",
  async (reason) => {
    const previous: GatewaySessionRow = {
      key: "agent:main:delayed-successor",
      agentId: "main",
      sessionId: "previous-session",
      kind: "direct",
      updatedAt: 1,
    };
    const successor = { ...previous, sessionId: "successor-session", updatedAt: 2 };
    const message = (text: string, seq: number) => ({
      role: "assistant",
      content: text,
      __openclaw: { id: text, seq },
    });
    const initial = {
      messages: [message("Earlier branch", 1), message("Old branch ending", 2)],
      sessionId: previous.sessionId,
      sessionInfo: previous,
      deltaCursor: "previous-cursor",
      hasMore: false,
    } satisfies ChatHistoryResult;
    const authoritative = {
      messages: [message("Selected branch", 1)],
      sessionId: successor.sessionId,
      sessionInfo: successor,
      deltaCursor: "successor-cursor",
      hasMore: false,
    } satisfies ChatHistoryResult;
    const replacementList = createDeferred<ReturnType<typeof sessionsResult>>();
    const successorHistory = createDeferred<ChatHistoryResult>();
    const admitted = createDeferred();
    let changed = false;
    const readList = vi.fn(() =>
      changed ? replacementList.promise : sessionsResult([previous], 1),
    );
    const readHistory = vi.fn<GatewayRequestHandler>(() =>
      changed ? successorHistory.promise : initial,
    );
    const { sessions, mount, emitGatewayEvent } = createMountedPanes(
      [previous],
      "main",
      undefined,
      {
        "sessions.list": readList,
        "chat.history": readHistory,
        "chat.startup": readHistory,
      },
    );
    let loading: Promise<unknown> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(previous.key);
      await refreshPane(pane);
      pane.state.chatMessage = "Keep this unsent draft";
      const displayed = pane.state.chatMessages;
      const unsubscribe = sessions.subscribe((state) => {
        if (state.result?.sessions.some((row) => row.sessionId === successor.sessionId)) {
          admitted.resolve();
        }
      });
      onTestFinished(unsubscribe);
      vi.useFakeTimers();
      changed = true;
      readHistory.mockClear();
      readList.mockClear();
      emitGatewayEvent("sessions.changed", {
        sessionKey: previous.key,
        sessionId: successor.sessionId,
        agentId: "main",
        reason,
        session: successor,
      });
      expect(selectedChatSessionRow(pane.state)).toMatchObject(previous);
      expect(readHistory).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(readList).toHaveBeenCalled();
      replacementList.resolve(sessionsResult([successor], 2));
      await admitted.promise;
      expect(selectedChatSessionRow(pane.state)).toMatchObject(successor);
      expect(pane.state.chatMessages).toBe(displayed);
      expect(pane.state.currentSessionId).toBe(previous.sessionId);
      expect(readHistory).toHaveBeenCalledOnce();
      const historyLoad = getChatHistoryLoadState(pane.state);
      expect(historyLoad.phase).toBe("in-flight");
      if (historyLoad.phase === "in-flight") {
        loading = historyLoad.promise;
      }
      successorHistory.resolve(authoritative);
      await loading;
      expect(pane.state.chatMessages).toEqual(authoritative.messages);
      expect(pane.state.currentSessionId).toBe(successor.sessionId);
      expect(pane.state.chatHistoryPagination.hasMore).toBe(false);
      expect(pane.state.chatMessage).toBe("Keep this unsent draft");
    } finally {
      replacementList.resolve(sessionsResult([successor], 2));
      successorHistory.resolve(authoritative);
      await loading;
      vi.useRealTimers();
    }
  },
);

it.each([false, true])(
  "delivers the successor-admitting frame only to its current transcript (reentrant newer incarnation: %s)",
  async (reentrant) => {
    const previous: GatewaySessionRow = {
      key: "agent:main:event-successor",
      agentId: "main",
      sessionId: "predecessor-session",
      kind: "direct",
      updatedAt: 1,
      label: "Predecessor",
    };
    const successor = {
      ...previous,
      sessionId: "successor-session",
      updatedAt: 2,
      label: "Successor",
    };
    const newer = {
      ...successor,
      sessionId: "newer-session",
      updatedAt: 3,
      label: "Newer incarnation",
    };
    const persisted = {
      role: "assistant",
      content: "Already accepted successor transcript",
      __openclaw: { id: "successor-history", seq: 1 },
    };
    const history: ChatHistoryResult = {
      messages: [persisted],
      sessionId: successor.sessionId,
      // Transcript custody can advance before the corresponding row metadata arrives.
    };
    const newerHistory = createDeferred<ChatHistoryResult>();
    const authoritative: ChatHistoryResult = {
      messages: [{ ...persisted, content: "Authoritative newer transcript" }],
      sessionId: newer.sessionId,
      sessionInfo: newer,
    };
    let newerAdmitted = false;
    const readHistory = vi.fn<GatewayRequestHandler>(() =>
      newerAdmitted ? newerHistory.promise : history,
    );
    let loading: Promise<unknown> | undefined;
    onTestFinished(async () => {
      newerHistory.resolve(authoritative);
      await loading;
    });
    const { sessions, mount, emitGatewayEvent } = createMountedPanes(
      [previous],
      "main",
      undefined,
      {
        // A canonical predecessor would fence different-ID events until a later list.
        "sessions.list": () => sessionsResult([], 1),
        "chat.history": readHistory,
        "chat.startup": readHistory,
      },
    );
    await sessions.refresh({ agentId: "main", force: true });
    expect(sessions.state.result?.sessions).toEqual([]);
    expect(sessions.captureReconcile()(previous, undefined, { resultAgentId: "main" })).toBe(true);
    let admitNewer = false;
    const early = sessions.observeRow({ key: previous.key, agentId: "main" }, () => {}, {
      onEvent: () => {
        if (admitNewer) {
          admitNewer = false;
          newerAdmitted =
            sessions.captureReconcile()(newer, undefined, { resultAgentId: "main" }) === true;
        }
      },
    });
    onTestFinished(early.dispose);
    const pane = mount(previous.key);
    await refreshPane(pane);
    // Keep the roster member supplemental: only the incoming frame may admit B.
    expect(sessions.captureReconcile()(previous, undefined, { resultAgentId: "main" })).toBe(true);
    expect(sessions.state.result?.sessions[0]).toMatchObject(previous);
    expect(selectedChatSessionRow(pane.state)).toMatchObject(previous);
    expect(pane.state.currentSessionId).toBe(successor.sessionId);
    expect(getChatSessionProjection(pane.state).scope.sessionId).toBe(successor.sessionId);
    expect(pane.state.chatMessages).toEqual([persisted]);
    const messagesBefore = pane.state.chatMessages;
    const message = {
      role: "user",
      content: "The first frame that also admits the successor row",
      __openclaw: { id: "successor-event-message", seq: 2 },
    };
    admitNewer = reentrant;
    readHistory.mockClear();
    emitGatewayEvent("session.message", {
      sessionKey: successor.key,
      agentId: "main",
      sessionId: successor.sessionId,
      messageId: "successor-event-message",
      messageSeq: 2,
      message,
      session: successor,
      ancestorSessions: [],
    });

    expect(newerAdmitted).toBe(reentrant);
    expect(sessions.state.result?.sessions[0]).toMatchObject(reentrant ? newer : successor);
    expect(selectedChatSessionRow(pane.state)).toMatchObject(reentrant ? newer : successor);
    // Row publication must not retag transcript bytes; only accepted history established B.
    expect(pane.state.currentSessionId).toBe(successor.sessionId);
    expect(getChatSessionProjection(pane.state).scope.sessionId).toBe(successor.sessionId);
    if (reentrant) {
      expect(pane.state.chatMessages).toBe(messagesBefore);
      expect(pane.state.chatMessages).toEqual([persisted]);
      const historyLoad = getChatHistoryLoadState(pane.state);
      if (historyLoad.phase === "in-flight") {
        loading = historyLoad.promise;
      }
      expect(readHistory).toHaveBeenCalledOnce();
      expect(historyLoad.phase).toBe("in-flight");
      newerHistory.resolve(authoritative);
      await loading;
      expect(pane.state.chatMessages).toEqual(authoritative.messages);
      expect(pane.state.currentSessionId).toBe(newer.sessionId);
    } else {
      expect(pane.state.chatMessages).toEqual([persisted, expect.objectContaining(message)]);
    }
  },
);

it.each(["event", "list"] as const)(
  "waits for authoritative successor history after %s admission before replacing a predecessor transcript",
  async (admission) => {
    const previous: GatewaySessionRow = {
      key: "agent:main:lagging-transcript",
      agentId: "main",
      sessionId: "predecessor-session",
      kind: "direct",
      updatedAt: 1,
    };
    const successor = { ...previous, sessionId: "successor-session", updatedAt: 2 };
    const predecessorMessage = {
      role: "assistant",
      content: "Predecessor transcript remains displayed until its replacement is read",
      __openclaw: { id: "predecessor-history", seq: 1 },
    };
    const successorMessage = {
      role: "user",
      content: "Successor input must never be appended into the predecessor",
      __openclaw: { id: "successor-input", seq: 2 },
    };
    const initial: ChatHistoryResult = {
      messages: [predecessorMessage],
      sessionId: previous.sessionId,
      sessionInfo: previous,
    };
    const authoritative = {
      messages: [
        {
          role: "assistant",
          content: "Earlier successor transcript supplied by authoritative history",
          __openclaw: { id: "successor-history", seq: 1 },
        },
        successorMessage,
      ],
      sessionId: successor.sessionId,
      sessionInfo: successor,
    } satisfies ChatHistoryResult;
    const successorHistory = createDeferred<ChatHistoryResult>();
    const historyRequested = createDeferred();
    let holdHistory = false;
    let successorReads = 0;
    const history = vi.fn<GatewayRequestHandler>(() => {
      if (!holdHistory) {
        return initial;
      }
      historyRequested.resolve();
      successorReads += 1;
      return successorReads === 1 ? successorHistory.promise : authoritative;
    });
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
    let refresh: ReturnType<typeof loadChatHistory> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      expect(sessions.state.result?.sessions).toEqual([]);
      const pane = mount(previous.key);
      await refreshPane(pane);
      expect(sessions.captureReconcile()(previous, undefined, { resultAgentId: "main" })).toBe(
        true,
      );
      const state = pane.state;
      expect(selectedChatSessionRow(state)).toMatchObject(previous);
      expect(state.currentSessionId).toBe(previous.sessionId);
      expect(getChatSessionProjection(state).scope.sessionId).toBe(previous.sessionId);
      expect(state.chatMessages).toEqual(initial.messages);
      const displayed = state.chatMessages;
      holdHistory = true;
      history.mockClear();
      if (admission !== "event") {
        listedRows = [successor];
        await sessions.refresh({ agentId: "main", force: true });
        expect(selectedChatSessionRow(state)).toMatchObject(successor);
        expect(state.currentSessionId).toBe(previous.sessionId);
        expect(state.chatMessages).toBe(displayed);
      }

      emitGatewayEvent("session.message", {
        sessionKey: successor.key,
        agentId: "main",
        sessionId: successor.sessionId,
        messageId: "successor-input",
        messageSeq: 2,
        message: successorMessage,
        hasActiveRun: true,
        session: successor,
        ancestorSessions: [],
      });
      // Reject mixed-incarnation display before the held history can repair it.
      expect(state.chatMessages).toBe(displayed);
      expect(state.chatMessages).toEqual(initial.messages);
      await historyRequested.promise;
      expect(history).toHaveBeenCalledExactlyOnceWith(
        "chat.history",
        expect.objectContaining({ sessionKey: successor.key }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(selectedChatSessionRow(state)).toMatchObject(successor);
      expect(state.currentSessionId).toBe(previous.sessionId);
      expect(getChatSessionProjection(state).scope.sessionId).toBe(previous.sessionId);
      expect(state.chatMessages).toBe(displayed);
      expect(state.chatMessages).toEqual(initial.messages);
      expect(
        readChatSessionSnapshot(state.chatMessagesBySession, state, { sessionKey: previous.key })
          ?.sessionId,
      ).toBe(previous.sessionId);

      // Join the event's read, including any successor read queued behind an older snapshot.
      refresh = loadChatHistory(state, { deferBranches: true });
      expect(history).toHaveBeenCalledTimes(1);
      successorHistory.resolve(
        admission === "list"
          ? { ...authoritative, messages: authoritative.messages.slice(0, 1) }
          : authoritative,
      );
      await refresh;
      expect(state.currentSessionId).toBe(successor.sessionId);
      expect(getChatSessionProjection(state).scope.sessionId).toBe(successor.sessionId);
      expect(state.chatMessages).toEqual(authoritative.messages);
      expect(
        readChatSessionSnapshot(state.chatMessagesBySession, state, { sessionKey: successor.key }),
      ).toMatchObject({ sessionId: successor.sessionId, messages: authoritative.messages });
      expect(history).toHaveBeenCalledTimes(admission === "list" ? 2 : 1);
    } finally {
      successorHistory.resolve(authoritative);
      await refresh;
      await vi.dynamicImportSettled();
    }
  },
);
