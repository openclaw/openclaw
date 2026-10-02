/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { isExpiredIncognitoSession } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { retryQueuedChatMessage } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

const privateKey = "agent:main:dashboard:incognito-expired";

it.each([
  { name: "missing private session", key: privateKey, sessionId: undefined, sends: 0 },
  { name: "valid empty private session", key: privateKey, sessionId: "existing", sends: 1 },
  {
    name: "ordinary uncreated session",
    key: "agent:main:dashboard:new",
    sessionId: undefined,
    sends: 1,
  },
])(
  "admits input according to authoritative history for $name",
  async ({ key, sessionId, sends }) => {
    const host = makeChatHost({
      sessionKey: key,
      requestHandlers: {
        "chat.history": { messages: [], sessionId },
        "chat.send": { status: "started", runId: "accepted-input" },
      },
      chatMessage: "Keep this unsent text",
    });
    await loadChatHistory(host);
    await handleSendChat(host);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(sends);
    if (!sends) {
      expect(host.chatMessage).toBe("Keep this unsent text");
      expect(host.chatQueue).toEqual([]);
    }
  },
);

it("does not apply a missing private result to a replacement session", async () => {
  const response = createDeferred<{ messages: never[] }>();
  const host = makeChatHost({
    sessionKey: privateKey,
    requestHandlers: {
      "chat.history": () => response.promise,
      "chat.send": { status: "started", runId: "accepted-input" },
    },
  });
  const loading = loadChatHistory(host);
  host.sessionKey = "agent:main:dashboard:other";
  response.resolve({ messages: [] });
  await loading;
  host.chatMessage = "New selection input";
  await handleSendChat(host);
  expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
});

it.each(["creation", "initial turn"] as const)(
  "does not expire a session whose history began during pending %s",
  async (pendingKind) => {
    const response = createDeferred<{ messages: never[] }>();
    let initialTurnPending = pendingKind === "initial turn";
    const host = makeChatHost({
      sessionKey: privateKey,
      hasPendingInitialTurn: () => initialTurnPending,
      requestHandlers: {
        "chat.history": () => response.promise,
        "chat.send": { status: "started", runId: "accepted-input" },
      },
    });
    const endCreation =
      pendingKind === "creation"
        ? host.chatSubmissions.beginCreate({
            creation: { sessionKey: privateKey, admitted: false },
            message: null,
            canDisplay: () => true,
          })
        : undefined;
    const loading = loadChatHistory(host);
    endCreation?.();
    initialTurnPending = false;
    response.resolve({ messages: [] });
    await loading;
    host.chatMessage = "Input after admission";
    await handleSendChat(host);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
  },
);

it.each(["client", "epoch"] as const)(
  "does not retain an expired result across a changed %s",
  async (replacement) => {
    const host = makeChatHost({
      sessionKey: privateKey,
      requestHandlers: { "chat.history": { messages: [] } },
    });
    await loadChatHistory(host);
    const next = makeChatHost({
      requestHandlers: { "chat.send": { status: "started", runId: "accepted-input" } },
    });
    if (replacement === "client") {
      host.client = next.client;
    } else {
      host.connectionEpoch += 1;
    }
    // Before a new authoritative read, the existing initial-history gate owns
    // admission; an old missing result must not label the new connection expired.
    expect(isExpiredIncognitoSession(host)).toBe(false);
  },
);

it("leaves a failed private input available without retrying an expired target", async () => {
  const failed = {
    id: "failed-private-input",
    text: "Keep the failed copy",
    createdAt: 1,
    sessionKey: privateKey,
    sendState: "failed" as const,
    sendError: "Incognito session was not found",
  };
  const host = makeChatHost({
    sessionKey: privateKey,
    chatQueue: [failed],
    requestHandlers: { "chat.history": { messages: [] } },
  });
  await loadChatHistory(host);
  await retryQueuedChatMessage(host, failed.id);
  expect(host.chatQueue).toEqual([failed]);
  expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
});
