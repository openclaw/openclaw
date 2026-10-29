import { beforeEach, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";

// Exercise the browser's real storage and Web Locks, not the unit DOM adapters.
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

it("settles a retired in-flight row quietly after a retryable response", async () => {
  const entered = createDeferred();
  const reply = createDeferred<unknown>();
  const host = makeChatHost({
    chatMessage: "Delivered input",
    requestHandlers: {
      "chat.send": () => {
        entered.resolve();
        return reply.promise;
      },
    },
  });
  const sending = handleSendChat(host);
  await entered.promise;
  const original = host.chatQueue[0]!;
  expect(listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue)).toHaveLength(1);
  expect(chatOutboxOwner(host).remove(host, original.id)?.id).toBe(original.id);
  reply.reject(
    new GatewayRequestError({
      code: "UNAVAILABLE",
      message: "temporary",
      retryable: true,
      retryAfterMs: 1,
    }),
  );
  await sending;
  expect(host.chatQueue).toEqual([]);
  expect(listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue)).toEqual([]);
  expect(host.chatMessage).toBe("");
  expect(host.lastError).toBeNull();
  expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
});
