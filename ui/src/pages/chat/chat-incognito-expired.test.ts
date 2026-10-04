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
  "missing private session",
  "valid empty private session",
  "ordinary uncreated session",
  "replacement selection",
  "pending creation",
  "pending initial turn",
])("admits input according to authoritative history for %s", async (scenario) => {
  const key = scenario === "ordinary uncreated session" ? "agent:main:dashboard:new" : privateKey;
  const response = createDeferred<{ messages: never[]; sessionId?: string }>();
  let initialTurnPending = scenario === "pending initial turn";
  const host = makeChatHost({
    sessionKey: key,
    hasPendingInitialTurn: () => initialTurnPending,
    chatMessage: "Keep this unsent text",
    requestHandlers: {
      "chat.history": () => response.promise,
      "chat.send": { status: "started", runId: "accepted-input" },
    },
  });
  const endCreation =
    scenario === "pending creation"
      ? host.chatSubmissions.beginCreate({
          creation: { sessionKey: privateKey, admitted: false },
          message: null,
          canDisplay: () => true,
        })
      : undefined;
  const loading = loadChatHistory(host);
  if (scenario === "replacement selection") {
    host.sessionKey = "agent:main:dashboard:other";
  }
  endCreation?.();
  initialTurnPending = false;
  response.resolve({
    messages: [],
    sessionId: scenario === "valid empty private session" ? "existing" : undefined,
  });
  await loading;
  await handleSendChat(host);
  const sends = scenario === "missing private session" ? 0 : 1;
  expect(requestCalls(host.request, "chat.send")).toHaveLength(sends);
  if (!sends) {
    expect(host.chatMessage).toBe("Keep this unsent text");
    expect(host.chatQueue).toEqual([]);
  }
});

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
