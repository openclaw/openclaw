// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { findChatSendPayload, makeChatHost, makeRequestMock } from "./chat-host.test-support.ts";
import {
  enqueueChatMessage,
  enqueuePendingRunMessage,
  removeQueuedMessageWithoutReleasing,
} from "./chat-queue.ts";
import {
  resumeStoredChatOutboxes,
  retryQueuedChatMessage,
  steerQueuedChatMessage,
} from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import {
  adoptStartedChatRun,
  reconcileChatRunAfterSessionStatePublication,
} from "./run-lifecycle.ts";
import { applyChatCacheSnapshot, type ChatSessionSnapshot } from "./session-message-cache.ts";

function cachedTranscript(sessionId: string, displayedLeafEntryId: string): ChatSessionSnapshot {
  return {
    messages: [],
    sessionId,
    displayedLeafEntryId,
    pagination: { hasMore: false, completeSnapshot: true },
  };
}

useChatSendBrowserFixture();

it.each([
  {
    newerEvent: false,
    reentrantSuccessor: false,
    mainKeyChanged: false,
    missingActivity: false,
    unqualified: false,
    defaultAgentId: "main",
  },
  {
    newerEvent: true,
    reentrantSuccessor: false,
    mainKeyChanged: false,
    missingActivity: false,
    unqualified: false,
    defaultAgentId: "main",
  },
  {
    newerEvent: false,
    reentrantSuccessor: true,
    mainKeyChanged: false,
    missingActivity: false,
    unqualified: false,
    defaultAgentId: "main",
  },
  {
    newerEvent: false,
    reentrantSuccessor: false,
    mainKeyChanged: true,
    missingActivity: false,
    unqualified: false,
    defaultAgentId: "main",
  },
  {
    newerEvent: true,
    reentrantSuccessor: false,
    mainKeyChanged: true,
    missingActivity: false,
    unqualified: false,
    defaultAgentId: "main",
  },
  {
    newerEvent: false,
    reentrantSuccessor: false,
    mainKeyChanged: false,
    missingActivity: true,
    unqualified: false,
    defaultAgentId: "main",
  },
  {
    newerEvent: false,
    reentrantSuccessor: false,
    mainKeyChanged: false,
    missingActivity: false,
    unqualified: true,
    defaultAgentId: "main",
  },
  {
    newerEvent: true,
    reentrantSuccessor: false,
    mainKeyChanged: false,
    missingActivity: false,
    unqualified: true,
    defaultAgentId: "main",
  },
  {
    newerEvent: false,
    reentrantSuccessor: false,
    mainKeyChanged: false,
    missingActivity: false,
    unqualified: true,
    defaultAgentId: "work",
  },
])(
  "recovers a missed terminal only while its session facts remain current (newer event: $newerEvent, reentrant successor: $reentrantSuccessor, mainKey changed: $mainKeyChanged, missing activity: $missingActivity, unqualified: $unqualified, default agent: $defaultAgentId)",
  async ({
    newerEvent,
    reentrantSuccessor,
    mainKeyChanged,
    missingActivity,
    unqualified,
    defaultAgentId,
  }) => {
    const sessionKey = unqualified
      ? "unknown"
      : mainKeyChanged
        ? "agent:main:main"
        : "agent:main:dashboard:missed-completion-event";
    const history = createDeferred<ChatHistoryResult>();
    const historyRequested = createDeferred();
    const activity: Pick<GatewaySessionRow, "status" | "hasActiveRun"> = missingActivity
      ? {}
      : { status: "done", hasActiveRun: false };
    let listed: GatewaySessionRow = {
      key: sessionKey,
      agentId: "main",
      sessionId: "current-session",
      kind: unqualified ? "unknown" : "direct",
      updatedAt: 1,
      ...activity,
    };
    const request = makeRequestMock({
      "sessions.list": () => sessionsResult([listed], listed.updatedAt ?? 0),
      "chat.history": () => {
        historyRequested.resolve();
        return history.promise;
      },
      "chat.send": { runId: "next-run", status: "started", messageSeq: 1 },
    });
    const client = createTestGatewayClient(request);
    const { gateway, emitEvent } = createGatewayHarness(client);
    gateway.snapshot.sessionKey = sessionKey;
    const sessions = createTestSessionCapability(gateway);
    const host = makeChatHost({
      client,
      sessions,
      sessionKey,
      currentSessionId: listed.sessionId,
      chatRunId: "finished-run",
      chatRunLifecycleGeneration: 1,
      chatStream: "The current answer is still streaming.",
      chatMessage: "Continue with the next change",
      ...(mainKeyChanged ? { agentsList: { defaultId: "main", mainKey: "main" } } : {}),
      ...(unqualified
        ? { assistantAgentId: "work", agentsList: { defaultId: defaultAgentId, mainKey: "main" } }
        : {}),
    });
    let successorStarted = false;
    const stop = sessions.subscribe((state) => {
      host.sessionsResult = state.result;
      host.sessionsResultAgentId = state.agentId;
      if (reconcileChatRunAfterSessionStatePublication(host) && reentrantSuccessor) {
        successorStarted = true;
        adoptStartedChatRun(host, "reentrant-run", 3);
        enqueuePendingRunMessage(host, "Command joined to the successor", "reentrant-run");
      }
    });
    let draining: ReturnType<typeof resumeStoredChatOutboxes> | undefined;
    let eventWake: ReturnType<typeof resumeStoredChatOutboxes> | undefined;
    const observation = sessions.observeRow({ key: sessionKey, agentId: "main" }, () => {}, {
      onEvent: (event) => {
        eventWake = resumeStoredChatOutboxes(host, event);
      },
    });
    try {
      await sessions.refresh({ agentId: "main", force: true });
      await handleSendChat(host, undefined, { followUpMode: "queue" });
      enqueuePendingRunMessage(host, "Command joined to the current run", "finished-run");
      expect(host.chatQueue).toHaveLength(2);
      const capturedOutboxes = listStoredChatOutboxes(host);
      const queuedIds = host.chatQueue.map((item) => item.id);
      if (unqualified) {
        expect(capturedOutboxes).toEqual([
          {
            sessionKey,
            queue: [expect.objectContaining({ text: "Continue with the next change" })],
          },
        ]);
      }
      if (mainKeyChanged) {
        expect(capturedOutboxes).toEqual([
          {
            sessionKey,
            agentId: "main",
            queue: [expect.objectContaining({ text: "Continue with the next change" })],
          },
        ]);
        host.agentsList = { defaultId: "main", mainKey: "workspace" };
        expect(listStoredChatOutboxes(host)).toEqual(capturedOutboxes);
      }

      const runGeneration = host.chatRunLifecycleGeneration;
      draining = resumeStoredChatOutboxes(host);
      await historyRequested.promise;
      expect(request).toHaveBeenCalledWith("chat.history", expect.anything());
      if (mainKeyChanged || unqualified) {
        expect(request).toHaveBeenCalledWith(
          "chat.history",
          expect.objectContaining({ sessionKey }),
        );
      }
      if (unqualified) {
        const historyRequests = request.mock.calls.filter(([method]) => method === "chat.history");
        for (const [, params] of historyRequests) {
          expect(params).not.toHaveProperty("agentId");
        }
      }
      if (newerEvent) {
        listed = {
          ...listed,
          updatedAt: 3,
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["finished-run"],
        };
        emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: { sessionKey, agentId: "main", reason: "run-capacity", session: listed },
        });
        expect(eventWake).toBeDefined();
      }
      expect(sessions.state.result?.sessions[0]).toMatchObject(listed);
      expect(host.chatRunId).toBe("finished-run");
      expect(host.chatRunLifecycleGeneration).toBe(runGeneration);
      expect(host.currentSessionId).toBe("current-session");

      history.resolve({
        messages: [],
        sessionInfo: {
          key: sessionKey,
          ...(unqualified ? { agentId: "main" } : {}),
          sessionId: "current-session",
          kind: unqualified ? "unknown" : "direct",
          updatedAt: 2,
          ...activity,
          lastRunId: "finished-run",
        },
      });
      await Promise.all([draining, eventWake]);

      const sends = request.mock.calls.filter(([method]) => method === "chat.send");
      if (missingActivity) {
        const projected = sessions.state.result?.sessions[0];
        expect(projected).toMatchObject({
          key: sessionKey,
          sessionId: "current-session",
          lastRunId: "finished-run",
        });
        expect(projected?.status).toBeUndefined();
        expect(projected?.hasActiveRun).toBeUndefined();
        expect(sends).toHaveLength(0);
        expect(host.chatRunId).toBe("finished-run");
        expect(host.chatRunLifecycleGeneration).toBe(runGeneration);
        expect(host.chatStream).toBe("The current answer is still streaming.");
        expect(host.chatQueue).toHaveLength(2);
        expect(host.chatQueue).toContainEqual(
          expect.objectContaining({
            text: "Command joined to the current run",
            pendingRunId: "finished-run",
          }),
        );
        return;
      }
      if (unqualified && defaultAgentId !== "main") {
        // The lifecycle matcher still refuses a row outside the current visible agent.
        expect(sends).toHaveLength(0);
        expect(host.chatRunId).toBe("finished-run");
        expect(host.chatRunLifecycleGeneration).toBe(runGeneration);
        expect(host.chatStream).toBe("The current answer is still streaming.");
        expect(host.chatQueue.map((item) => item.id)).toEqual(queuedIds);
        expect(listStoredChatOutboxes(host)).toEqual(capturedOutboxes);
        return;
      }
      if (mainKeyChanged) {
        expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([sessionKey]);
        if (newerEvent) {
          expect(sends).toHaveLength(0);
          expect(host.chatRunId).toBe("finished-run");
          expect(host.chatStream).toBe("The current answer is still streaming.");
          expect(listStoredChatOutboxes(host)).toEqual(capturedOutboxes);
          expect(sessions.state.result?.sessions[0]).toMatchObject(listed);
          return;
        }
        expect(listStoredChatOutboxes(host)).toEqual([]);
      }
      if (reentrantSuccessor) {
        expect(successorStarted).toBe(true);
        expect(sends).toHaveLength(0);
        expect(host.chatRunId).toBe("reentrant-run");
        expect(host.chatQueue).toHaveLength(2);
        expect(host.chatQueue.some((item) => item.pendingRunId === "finished-run")).toBe(false);
        expect(host.chatQueue.some((item) => item.pendingRunId === "reentrant-run")).toBe(true);
        return;
      }
      if (!newerEvent) {
        expect(sends).toHaveLength(1);
        if (unqualified) {
          expect(observation.row).toMatchObject({
            key: sessionKey,
            agentId: "main",
            sessionId: "current-session",
            lastRunId: "finished-run",
          });
        }
        expect(sends[0]?.[1]).toMatchObject({
          sessionKey,
          message: "Continue with the next change",
        });
        if (unqualified) {
          expect(sends[0]?.[1]).not.toHaveProperty("agentId");
        }
        expect(host.chatRunId).toBe("next-run");
        expect(host.chatQueue).toEqual([]);
        return;
      }
      expect(sends).toHaveLength(0);
      expect(host.chatRunId).toBe("finished-run");
      expect(host.chatStream).toBe("The current answer is still streaming.");
      expect(host.chatQueue).toHaveLength(2);
      if (unqualified) {
        expect(listStoredChatOutboxes(host)).toEqual(capturedOutboxes);
        expect(host.chatQueue.map((item) => item.id)).toEqual(queuedIds);
      }
      expect(sessions.state.result?.sessions[0]).toMatchObject(listed);
    } finally {
      history.resolve({ messages: [], sessionInfo: listed });
      await Promise.allSettled([draining, eventWake]);
      observation.dispose();
      stop();
      sessions.dispose();
    }
  },
);

it.each(["same run", "new run", "new session", "different terminal", "still active"])(
  "reconciles queued input against terminal history (%s)",
  async (scenario) => {
    const sessionKey = "agent:main:dashboard:missed-completion";
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      sessionKey,
      currentSessionId: "current-session",
      chatRunId: "finished-run",
      chatStream: "The previous answer is complete.",
      chatMessage: "Continue with the next change",
      requestHandlers: {
        "chat.history": () => history.promise,
        "chat.send": { runId: "next-run", status: "started", messageSeq: 1 },
      },
    });
    await handleSendChat(host, undefined, { followUpMode: "queue" });
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(host.chatQueue).toHaveLength(1);
    enqueuePendingRunMessage(host, "Command joined to the previous run", "finished-run");

    const draining = resumeStoredChatOutboxes(host);
    await vi.waitFor(() =>
      expect(host.request).toHaveBeenCalledWith("chat.history", expect.anything()),
    );
    if (scenario === "new run") {
      host.chatRunId = "newer-run";
    } else if (scenario === "new session") {
      host.currentSessionId = "replacement-session";
    }
    history.resolve({
      messages: [],
      sessionInfo: {
        key: sessionKey,
        sessionId: "current-session",
        kind: "direct",
        status: scenario === "still active" ? "running" : "done",
        lastRunId: scenario === "different terminal" ? "older-run" : "finished-run",
        updatedAt: 2,
      },
    });
    await draining;

    if (scenario !== "same run") {
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      expect(host.chatQueue).toHaveLength(2);
      expect(host.chatRunId).toBe(scenario === "new run" ? "newer-run" : "finished-run");
      return;
    }
    expect(findChatSendPayload(host)).toMatchObject({
      sessionKey,
      message: "Continue with the next change",
    });
    expect(host.chatRunId).toBe("next-run");
    expect(host.chatQueue).toEqual([]);
  },
);

it.each(
  [
    { message: "/stop", action: "abort" },
    { message: "/approve approval-123 allow-once", action: "approve" },
    { message: "ordinary draft", action: "queued" },
    { message: "/stop after the next turn", action: "blocked" },
    { message: "/stop", action: "goal" },
  ].flatMap((test) =>
    (test.action === "approve" ? [true, false] : [true]).map((hydrated) => ({
      message: test.message,
      action: test.action,
      hydrated,
    })),
  ),
)(
  "keeps $action admission separate from initial history (run hydrated: $hydrated)",
  async ({ message, action, hydrated }) => {
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      chatMessage: message,
      chatRunId: hydrated ? "waiting-run" : null,
      chatStream: hydrated ? "Waiting for approval" : null,
      requestHandlers: {
        "chat.startup": () => history.promise,
        "chat.abort": { aborted: true },
        "chat.send": { runId: "approval-command", status: "started" },
      },
    });
    const loading = loadChatHistory(host, { startup: true, deferBranches: true });
    const sending = handleSendChat(
      host,
      undefined,
      action === "goal"
        ? { intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() } }
        : undefined,
    );
    try {
      if (action === "queued") {
        await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      } else if (action === "approve") {
        await vi.waitFor(() =>
          expect(findChatSendPayload(host)).toMatchObject({ sessionKey: host.sessionKey, message }),
        );
      } else {
        await sending;
      }
      expect(host.chatLoading).toBe(true);
      if (action === "abort") {
        expect(host.request).toHaveBeenCalledWith("chat.abort", {
          runId: "waiting-run",
          sessionKey: host.sessionKey,
        });
      } else {
        expect(host.request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
      }
      if (action === "approve") {
        expect(findChatSendPayload(host)).toMatchObject({ sessionKey: host.sessionKey, message });
        expect(
          host.request.mock.calls.filter(([method]) => method === "chat.history"),
        ).toHaveLength(0);
      } else {
        expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      }
      if (action === "queued") {
        expect(host.chatQueue).toEqual([
          expect.objectContaining({ text: message, sendAttempts: 0 }),
        ]);
        expect(host.chatMessage).toBe("");
      } else {
        expect(host.chatQueue).toEqual([]);
      }
      if (action === "blocked" || action === "goal") {
        expect(host.chatMessage).toBe(message);
      }
    } finally {
      history.resolve({ messages: [] });
      await loading;
      await sending;
    }
  },
);

it.each(["replacement Gateway", "reconnected client", "offline pane"] as const)(
  "keeps early queued delivery scoped through a %s",
  async (change) => {
    const sessionKey = "agent:main:main";
    const accepted: ChatHistoryResult = {
      sessionId: "old-session",
      messages: [],
      sessionInfo: { key: sessionKey, sessionId: "old-session", kind: "direct", updatedAt: 1 },
    };
    const history = createDeferred<ChatHistoryResult>();
    let initial = true;
    const requestHandlers = {
      "chat.startup": () => (initial ? accepted : history.promise),
      "chat.history": accepted,
      "chat.send": { runId: "new-run", status: "started" },
    };
    const host = makeChatHost({
      sessionKey,
      chatMessage: "Keep this draft unsent",
      requestHandlers,
    });
    await loadChatHistory(host, { startup: true, deferBranches: true });
    initial = false;
    const next =
      change === "replacement Gateway" ? makeChatHost({ sessionKey, requestHandlers }) : host;
    host.client = next.client;
    host.sessions = next.sessions;
    host.connectionEpoch += 1;
    if (change === "offline pane") {
      host.connected = false;
    }
    const loading =
      change === "offline pane"
        ? Promise.resolve()
        : loadChatHistory(host, { startup: true, deferBranches: true });
    const sending = handleSendChat(host);
    await vi.waitFor(() => expect(host.chatMessage).toBe(""));
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(next.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    history.resolve(accepted);
    await loading;
    await sending;
    if (change === "offline pane") {
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      expect(host.chatQueue).toEqual([expect.objectContaining({ text: "Keep this draft unsent" })]);
      expect(host.chatMessage).toBe("");
    } else {
      expect(findChatSendPayload(next)).toMatchObject({
        message: "Keep this draft unsent",
        sessionId: "old-session",
      });
      if (next !== host) {
        expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      }
    }
  },
);

it.each(["steer", "retry"] as const)(
  "holds queued %s without changing custody during initial history",
  async (action) => {
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      chatRunId: "current-run",
      requestHandlers: {
        "chat.startup": () => history.promise,
        "chat.send": { runId: "queued-send", status: "started" },
      },
    });
    const queued = enqueueChatMessage(host, "already queued", false);
    if (!queued) {
      throw new Error("Expected an admitted queue item");
    }
    const before = structuredClone(host.chatQueue);
    const loading = loadChatHistory(host, { startup: true, deferBranches: true });
    try {
      await (action === "steer" ? steerQueuedChatMessage : retryQueuedChatMessage)(host, queued.id);
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      expect(host.chatQueue).toEqual(before);
    } finally {
      history.resolve({ messages: [] });
      await loading;
    }
  },
);

it.each([false, true])(
  "accepts a restored transcript draft before history and delivers to the authoritative session (attachment: %s)",
  async (withAttachment) => {
    const history = createDeferred<ChatHistoryResult>();
    const current: ChatHistoryResult = {
      sessionId: "current-session",
      messages: [],
      sessionInfo: {
        key: "agent:main:main",
        sessionId: "current-session",
        kind: "direct",
        updatedAt: 1,
        activeLeafEntryId: "current-leaf",
      },
    };
    const host = makeChatHost({
      chatMessage: "Draft while restoring history",
      chatAttachments: withAttachment
        ? [
            {
              id: "early-file",
              mimeType: "text/plain",
              fileName: "note.txt",
              dataUrl: "data:text/plain;base64,aGVsbG8=",
            },
          ]
        : [],
      requestHandlers: {
        "chat.startup": () => history.promise,
        "chat.history": current,
        "chat.send": { status: "started" },
      },
    });
    applyChatCacheSnapshot(host, cachedTranscript("restored-session", "restored-leaf"));
    const loading = loadChatHistory(host, { startup: true, deferBranches: true });
    const sending = handleSendChat(host);
    try {
      await vi.waitFor(() => expect(host.chatMessage).toBe(""));
      expect(host.currentSessionId).toBe("restored-session");
      expect(host.chatQueue).toEqual([
        expect.objectContaining({ text: "Draft while restoring history", sendAttempts: 0 }),
      ]);
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(
        0,
      );
      expect(host.chatAttachments).toEqual([]);
      host.chatMessage = "Next draft";
    } finally {
      history.resolve(current);
      await loading;
      await sending;
    }
    expect(findChatSendPayload(host)).toMatchObject({
      message: "Draft while restoring history",
      sessionId: "current-session",
      expectedLeafEntryId: "current-leaf",
    });
    expect(host.chatMessage).toBe("Next draft");
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    if (withAttachment) {
      expect(findChatSendPayload(host).attachments).toEqual([
        expect.objectContaining({
          content: "aGVsbG8=",
          fileName: "note.txt",
          mimeType: "text/plain",
        }),
      ]);
    }
  },
);

it.each(["original-leaf", null])(
  "preserves the submitted leaf fence %s when history starts after outbox admission",
  async (expectedLeafEntryId) => {
    const sessionKey = "agent:main:main";
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      sessionKey,
      currentSessionId: "current-session",
      chatDisplayedLeafEntryId: expectedLeafEntryId,
      chatMessage: "Send against the branch I selected",
      requestHandlers: {
        "chat.history": () => history.promise,
        "chat.send": { status: "started", messageSeq: 1 },
      },
    });
    let loading: ReturnType<typeof loadChatHistory> | undefined;
    const sending = handleSendChat(host, undefined, {
      onOutboxAdmitted: () => {
        loading = loadChatHistory(host, { deferBranches: true });
      },
    });
    try {
      await vi.waitFor(() => expect(host.chatLoading).toBe(true));
      expect(host.chatMessage).toBe("");
      expect(host.chatQueue).toHaveLength(1);
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    } finally {
      history.resolve({
        messages: [],
        sessionInfo: {
          key: sessionKey,
          sessionId: "current-session",
          activeLeafEntryId: "different-branch-leaf",
          kind: "direct",
          updatedAt: 2,
        },
      });
      await loading;
      await sending;
    }

    expect(host.chatDisplayedLeafEntryId).toBe("different-branch-leaf");
    expect(findChatSendPayload(host)).toHaveProperty("expectedLeafEntryId", expectedLeafEntryId);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  },
);

it.each(["connection", "conversation", "discard"] as const)(
  "does not deliver stale queued work after a %s change during history",
  async (change) => {
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      chatMessage: "Queued before history",
      requestHandlers: {
        "chat.startup": () => history.promise,
        "chat.send": { status: "started" },
      },
    });
    const loading = loadChatHistory(host, { startup: true, deferBranches: true });
    const sending = handleSendChat(host);
    try {
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      if (change === "connection") {
        host.connectionEpoch += 1;
      } else if (change === "conversation") {
        host.sessionKey = "agent:main:another-conversation";
      } else {
        removeQueuedMessageWithoutReleasing(host, host.chatQueue[0]!.id);
      }
    } finally {
      history.resolve({ messages: [], sessionId: "old-session" });
      await loading;
      await sending;
    }
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(host.chatMessage).toBe("");
  },
);

it.each([false, true])(
  "delivers the next early message after discarding the first during history (switch pane: %s)",
  async (switchPane) => {
    const sessionKey = "agent:main:main";
    const history = createDeferred<ChatHistoryResult>();
    const current: ChatHistoryResult = {
      messages: [],
      sessionInfo: {
        key: sessionKey,
        sessionId: "current-session",
        activeLeafEntryId: "current-leaf",
        hasActiveRun: false,
        status: "done",
        kind: "direct",
        updatedAt: 1,
      },
    };
    const host = makeChatHost({
      sessionKey,
      chatMessage: "Discard this first message",
      requestHandlers: {
        "chat.startup": () => history.promise,
        "chat.history": current,
        "chat.send": { status: "started", messageSeq: 1 },
      },
    });
    applyChatCacheSnapshot(host, cachedTranscript("cached-session", "cached-leaf"));
    const loading = loadChatHistory(host, { startup: true, deferBranches: true });
    const sending = [handleSendChat(host)];
    try {
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      const firstId = host.chatQueue[0]!.id;
      host.chatMessage = "Keep this second message";
      sending.push(handleSendChat(host));
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(2));
      removeQueuedMessageWithoutReleasing(host, firstId);
      expect(host.chatQueue).toEqual([
        expect.objectContaining({ text: "Keep this second message", sendAttempts: 0 }),
      ]);
      expect(host.chatMessage).toBe("");
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      if (switchPane) {
        host.sessionKey = "agent:main:other";
        host.currentSessionId = "other-session";
        host.chatDisplayedLeafEntryId = "other-leaf";
      }
    } finally {
      history.resolve(current);
      await loading;
      await Promise.all(sending);
    }

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    const payload = findChatSendPayload(host);
    expect(payload).toMatchObject({
      sessionKey,
      message: "Keep this second message",
    });
    if (switchPane) {
      expect(payload).not.toHaveProperty("sessionId");
      expect(host.request).toHaveBeenCalledWith(
        "chat.history",
        expect.objectContaining({ sessionKey }),
      );
    } else {
      expect(payload.sessionId).toBe("current-session");
    }
    expect(payload).not.toHaveProperty("expectedLeafEntryId", "cached-leaf");
    expect(host.chatQueue).toEqual([]);
  },
);

it.each(["steer", "interrupt", "queue"] as const)(
  "preserves the selected %s policy when initial history reveals an active run",
  async (followUpMode) => {
    const sessionKey = "agent:main:main";
    const message = "Apply my selected follow-up mode";
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      sessionKey,
      chatMessage: message,
      sessionsResult: {
        ts: 1,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: sessionKey,
            sessionId: "current-session",
            hasActiveRun: false,
            status: "done",
            kind: "direct",
            updatedAt: 1,
          },
        ],
      },
      requestHandlers: {
        "chat.startup": () => history.promise,
        "chat.send": { status: "started", messageSeq: 1 },
      },
    });
    applyChatCacheSnapshot(host, cachedTranscript("current-session", "cached-leaf"));
    const loading = loadChatHistory(host, { startup: true, deferBranches: true });
    const sending = handleSendChat(host, undefined, { followUpMode });
    try {
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      expect(host.chatMessage).toBe("");
      expect(host.chatQueue[0]).toMatchObject({ text: message, sendAttempts: 0 });
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    } finally {
      history.resolve({
        messages: [],
        inFlightRun: { runId: "active-run", text: "Work started after the cached snapshot" },
        sessionInfo: {
          key: sessionKey,
          sessionId: "current-session",
          activeLeafEntryId: "active-leaf",
          activeRunIds: ["active-run"],
          hasActiveRun: true,
          status: "running",
          kind: "direct",
          updatedAt: 2,
        },
      });
      await loading;
      await sending;
    }

    if (followUpMode === "queue") {
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      expect(host.chatQueue).toEqual([
        expect.objectContaining({ text: message, sendAttempts: 0, sendState: "waiting-idle" }),
      ]);
    } else {
      expect(findChatSendPayload(host)).toMatchObject({
        sessionKey,
        message,
        queueMode: followUpMode,
      });
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
      expect(host.chatQueue).toEqual([]);
    }
  },
);

it.each(["steer", "interrupt"] as const)(
  "resumes an early %s message for its captured session after switching panes",
  async (queueMode) => {
    const sessionKey = "agent:work:research";
    const message = "Continue the selected work";
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      sessionKey,
      currentSessionId: "cached-source-session",
      chatDisplayedLeafEntryId: "cached-source-leaf",
      chatRunId: "cached-source-run",
      chatFollowUpMode: queueMode,
      chatMessage: message,
      requestHandlers: {
        "chat.startup": () => history.promise,
        "chat.send": { status: "started", messageSeq: 1 },
      },
    });
    const loading = loadChatHistory(host, { startup: true, deferBranches: true });
    const sending = handleSendChat(host);
    try {
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      expect(host.chatMessage).toBe("");
      expect(host.chatQueue[0]).toMatchObject({ sessionKey, queueMode, sendAttempts: 0 });
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      host.sessionKey = "agent:main:another-conversation";
      host.currentSessionId = "new-pane-session";
      host.chatDisplayedLeafEntryId = "new-pane-leaf";
      host.chatRunId = null;
    } finally {
      history.resolve({ messages: [], sessionId: "source-session" });
      await loading;
      await sending;
    }
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());

    await resumeStoredChatOutboxes(host);

    const payload = findChatSendPayload(host);
    expect(payload).toMatchObject({ sessionKey, queueMode, message });
    expect(payload).not.toHaveProperty("sessionId");
    expect(payload).not.toHaveProperty("expectedLeafEntryId");
    expect(payload).not.toHaveProperty("expectedRunId");
    expect(host.currentSessionId).toBe("new-pane-session");
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  },
);
