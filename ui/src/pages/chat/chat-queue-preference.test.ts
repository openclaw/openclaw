import { expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { expectRequestCounts, makeChatHost } from "./chat-host.test-support.ts";
import {
  chatQueuePreferenceTarget,
  readCollectClient,
  setChatQueuePreference,
} from "./chat-queue-preference.ts";
import { updateQueuedMessage } from "./chat-queue.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

const scope = { sessionKey: "agent:main:main", agentId: "main" };
const user = { id: "test-user", identity: { type: "profile" as const, id: "test-user" } };

it("persists only for the authenticated Gateway and conversation, not the socket instance", () => {
  vi.stubGlobal("localStorage", createStorageMock());
  const host = makeChatHost({
    sessionKey: scope.sessionKey,
    currentSessionId: "session-one",
    selfUser: user,
    settings: { gatewayUrl: "ws://localhost:12345" },
    requestHandlers: {},
  });
  const target = chatQueuePreferenceTarget(host, scope)!;
  expect(readCollectClient(host, scope)).toBeUndefined();
  expect(setChatQueuePreference(target.key, true)).toBe(true);
  expect(readCollectClient(host, scope)).toBe(target.client);
  const reopened = makeChatHost({
    sessionKey: scope.sessionKey,
    currentSessionId: "session-one",
    selfUser: user,
    settings: { gatewayUrl: "ws://localhost:12345" },
    requestHandlers: {},
  });
  expect(readCollectClient(reopened, scope)).toBe(target.client);
  expect(readCollectClient(host, { ...scope, sessionKey: "agent:main:other" })).toBeUndefined();
  expect(readCollectClient({ ...host, currentSessionId: "replacement" }, scope)).toBeUndefined();
  expect(readCollectClient({ ...host, selfUser: null }, scope)).toBeUndefined();
  expect(
    readCollectClient(
      {
        ...host,
        selfUser: {
          id: "different",
          identity: { type: "profile", id: "different" },
        },
      },
      scope,
    ),
  ).toBeUndefined();
  expect(
    readCollectClient(
      {
        ...host,
        settings: {
          ...host.settings,
          gatewayUrl: "ws://localhost:12346",
        },
      },
      scope,
    ),
  ).toBeUndefined();
  expect(setChatQueuePreference(target.key, false)).toBe(true);
  expect(readCollectClient(reopened, scope)).toBeUndefined();
});

it("parks an ordinary follow-up despite Server steer, but keeps explicit steering immediate", async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  const host = makeChatHost({
    sessionKey: scope.sessionKey,
    currentSessionId: "session-one",
    selfUser: user,
    chatFollowUpMode: "steer",
    chatRunId: "busy",
    chatMessage: "send in a new turn",
    requestHandlers: {
      "chat.send": () => ({ runId: "busy", status: "steered" }),
    },
  });
  const target = chatQueuePreferenceTarget(host, scope)!;
  expect(setChatQueuePreference(target.key, true)).toBe(true);
  await handleSendChat(host);
  expect(host.chatQueue).toMatchObject([
    { text: "send in a new turn", collectClient: target.client },
  ]);
  expectRequestCounts(host.request, { "chat.send": 0 });
  host.chatMessage = "steer into the current turn";
  await handleSendChat(host, undefined, { followUpMode: "steer" });
  expectRequestCounts(host.request, { "chat.send": 1 });
  expect(host.request.mock.calls.find(([method]) => method === "chat.send")?.[1]).toMatchObject({
    message: "steer into the current turn",
    queueMode: "steer",
  });
});

it("sends a restored text row with an old collection tab ID before newer rows", async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  const host = makeChatHost({
    sessionKey: scope.sessionKey,
    currentSessionId: "session-one",
    selfUser: user,
    chatRunId: "busy",
    chatMessage: "restored first follow-up",
    requestHandlers: {
      "chat.history": {
        messages: [],
        sessionId: "session-one",
        sessionInfo: { key: scope.sessionKey, status: "done", hasActiveRun: false },
      },
      "chat.send": (params) => ({
        runId: (params as { idempotencyKey: string }).idempotencyKey,
        status: "started",
      }),
    },
  });
  const target = chatQueuePreferenceTarget(host, scope)!;
  expect(setChatQueuePreference(target.key, true)).toBe(true);
  await handleSendChat(host);
  const head = host.chatQueue[0]!;
  expect(head.sendRunId).toBeTruthy();
  updateQueuedMessage(host, head.id, (item) => ({
    ...item,
    collectTabId: "old-tab-without-a-lease-conflict",
  }));
  host.chatMessage = "newer waiting follow-up";
  await handleSendChat(host);
  expectRequestCounts(host.request, { "chat.send": 0 });

  host.chatRunId = null;
  await resumeStoredChatOutboxes(host);
  const sends = host.request.mock.calls.filter(([method]) => method === "chat.send");
  expect(sends[0]?.[1]).toMatchObject({
    message: "restored first follow-up",
    idempotencyKey: head.sendRunId,
  });
});
