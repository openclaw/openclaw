import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { requestCalls, makeChatHost } from "./chat-host.test-support.ts";
import { admitHostQueueItems } from "./chat-outbox-recovery.test-support.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

it.each([false, true])(
  "consumes foreground reconciliation before a pending history response (new follow-up: %s)",
  async (newFollowUp) => {
    const sessionKey = "agent:main:active-follow-up";
    const sessionId = "same-session";
    const row = {
      key: sessionKey,
      sessionId,
      kind: "direct" as const,
      updatedAt: 1,
      hasActiveRun: true,
      activeRunIds: ["active-run"],
      status: "running" as const,
    };
    const history = {
      sessionId,
      messages: [],
      sessionInfo: row,
      inFlightRun: { runId: "active-run", text: "Still working." },
    };
    const pendingHistory = createDeferred<typeof history>();
    const readHistory = vi
      .fn()
      .mockImplementationOnce(() => pendingHistory.promise)
      .mockResolvedValue(history);
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      sessionsResult: sessionsResult([row], 1),
      chatRunId: "active-run",
      chatStream: "Still working.",
      chatMessage: "First follow-up",
      requestHandlers: { "chat.history": readHistory },
    });
    await handleSendChat(host, undefined, { followUpMode: "queue" });
    await vi.waitFor(() => expect(readHistory).toHaveBeenCalledTimes(1));
    if (newFollowUp) {
      host.chatMessage = "Second follow-up";
      await handleSendChat(host, undefined, { followUpMode: "queue" });
    }
    const draining = resumeStoredChatOutboxes(host, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey, ...row },
    });
    pendingHistory.resolve(history);
    await draining;
    expect(requestCalls(host.request, "chat.history")).toHaveLength(newFollowUp ? 2 : 1);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    expect(host.chatQueue.map((item) => item.text)).toEqual(
      newFollowUp ? ["First follow-up", "Second follow-up"] : ["First follow-up"],
    );
    expect(host.chatRunId).toBe("active-run");
  },
);

function recoveryFixture() {
  const sessionKey = "agent:main:missed-terminal";
  const sessionId = "original-session";
  const active = {
    key: sessionKey,
    sessionId,
    kind: "direct" as const,
    updatedAt: 1,
    hasActiveRun: true,
    activeRunIds: ["finished-run"],
    status: "running" as const,
  };
  const idle = {
    ...active,
    updatedAt: 2,
    hasActiveRun: false,
    activeRunIds: [],
    lastRunId: "finished-run",
    status: "done" as const,
  };
  return {
    sessionKey,
    sessionId,
    active,
    history: { sessionId, messages: [], sessionInfo: idle, inFlightRun: null },
  };
}

it("recovers the first parked follow-up from authoritative idle history exactly once", async () => {
  const fixture = recoveryFixture();
  const host = makeChatHost({
    sessionKey: fixture.sessionKey,
    currentSessionId: fixture.sessionId,
    sessionsResult: sessionsResult([fixture.active], 1),
    chatRunId: "finished-run",
    chatStream: "Stale in-flight text",
    chatMessage: "First follow-up",
    requestHandlers: {
      "chat.history": fixture.history,
      "chat.send": { runId: "next-run", status: "started", messageSeq: 1 },
    },
  });
  await handleSendChat(host, undefined, { followUpMode: "queue" });
  await vi.waitFor(() => expect(requestCalls(host.request, "chat.send")).toHaveLength(1));
  await resumeStoredChatOutboxes(host);
  expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
  expect(requestCalls(host.request, "chat.send")[0]?.[1]).toMatchObject({
    sessionKey: fixture.sessionKey,
    message: "First follow-up",
  });
  expect(host.chatQueue).toHaveLength(0);
  expect(host.chatStream).not.toBe("Stale in-flight text");
});

it("keeps passive active-row drains cheap without reading history", async () => {
  const fixture = recoveryFixture();
  const host = makeChatHost({
    sessionKey: fixture.sessionKey,
    currentSessionId: fixture.sessionId,
    sessionsResult: sessionsResult([fixture.active], 1),
    chatRunId: "finished-run",
    chatQueue: [
      {
        id: "older",
        text: "Earlier parked input",
        createdAt: 1,
        sessionKey: fixture.sessionKey,
        sessionId: fixture.sessionId,
        sendRunId: "older-run",
        sendState: "waiting-idle",
        sendAttempts: 0,
      },
    ],
    chatMessage: "Foreground follow-up",
    requestHandlers: {
      "chat.history": vi
        .fn()
        .mockResolvedValueOnce(fixture.history)
        .mockResolvedValue({
          ...fixture.history,
          sessionInfo: { ...fixture.active, activeRunIds: ["older-run"] },
          inFlightRun: { runId: "older-run", text: "Now handling the earlier input" },
        }),
      "chat.send": { runId: "older-run", status: "started", messageSeq: 1 },
    },
  });
  admitHostQueueItems(host);
  await resumeStoredChatOutboxes(host);
  expect(requestCalls(host.request, "chat.history")).toHaveLength(0);
  expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
});

it("does not replay an unconfirmed predecessor on a foreground recovery request", async () => {
  const fixture = recoveryFixture();
  const host = makeChatHost({
    sessionKey: fixture.sessionKey,
    currentSessionId: fixture.sessionId,
    sessionsResult: sessionsResult([fixture.active], 1),
    chatRunId: "finished-run",
    chatQueue: [
      {
        id: "uncertain",
        text: "Possibly delivered",
        createdAt: 1,
        sessionKey: fixture.sessionKey,
        sessionId: fixture.sessionId,
        sendRunId: "uncertain-run",
        sendState: "unconfirmed",
        sendAttempts: 1,
        sendRequestStartedAtMs: 1,
      },
    ],
    chatMessage: "Must wait behind uncertain send",
    requestHandlers: { "chat.history": fixture.history },
  });
  admitHostQueueItems(host);
  await handleSendChat(host, undefined, { followUpMode: "queue" });
  await vi.waitFor(() => expect(requestCalls(host.request, "chat.history")).toHaveLength(1));
  await resumeStoredChatOutboxes(host);
  expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
  expect(host.chatQueue[0]).toMatchObject({ id: "uncertain", sendState: "unconfirmed" });
  expect(host.chatQueue).toHaveLength(2);
});

it.each(["epoch", "client", "disconnect", "physical session"] as const)(
  "does not let a stale foreground history response cross %s ownership",
  async (change) => {
    const fixture = recoveryFixture();
    const pending = createDeferred<typeof fixture.history>();
    const host = makeChatHost({
      sessionKey: fixture.sessionKey,
      currentSessionId: fixture.sessionId,
      sessionsResult: sessionsResult([fixture.active], 1),
      chatRunId: "finished-run",
      chatMessage: "Held follow-up",
      requestHandlers: { "chat.history": () => pending.promise },
    });
    await handleSendChat(host, undefined, { followUpMode: "queue" });
    await vi.waitFor(() => expect(requestCalls(host.request, "chat.history")).toHaveLength(1));
    const drain = resumeStoredChatOutboxes(host);
    if (change === "epoch") {
      host.connectionEpoch += 1;
    } else if (change === "client") {
      host.client = createTestGatewayClient(async () => ({}));
    } else if (change === "disconnect") {
      host.connected = false;
    }
    pending.resolve(
      change === "physical session"
        ? {
            ...fixture.history,
            sessionId: "replacement",
            sessionInfo: { ...fixture.history.sessionInfo, sessionId: "replacement" },
          }
        : fixture.history,
    );
    await drain;
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    expect(host.chatQueue.map((item) => item.text)).toEqual(["Held follow-up"]);
  },
);
