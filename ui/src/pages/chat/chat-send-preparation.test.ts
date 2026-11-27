// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { INTERRUPTED_SETTINGS_WAIT_ERROR } from "../../lib/chat/outbox-store-codec.ts";
import { expectNoRpc, findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { admitHostQueueItems } from "./chat-outbox-recovery.test-support.ts";
import {
  keepVolatileQueuedMessage,
  readQueuedMessageById,
  updateQueuedMessage,
} from "./chat-queue.ts";
import { sendQueuedChatMessage } from "./chat-send-delivery.ts";
import { queued } from "./chat-thread-fixtures.test-support.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

const { prepareStreaming } = vi.hoisted(() => ({
  prepareStreaming: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
}));
vi.mock("../../components/markdown-live-loader.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/markdown-live-loader.ts")>()),
  loadStreamingMarkdown: prepareStreaming,
}));

useChatSendBrowserFixture();

beforeEach(() => {
  vi.doMock("./chat-send-delivery.runtime.ts", (importOriginal) => importOriginal());
});

afterEach(() => vi.doUnmock("./chat-send-delivery.runtime.ts"));

it.each(
  (["durable", "memory"] as const).flatMap((storageMode) =>
    (["ready", "rejected", "connection replaced", "row replaced", "cancelled"] as const).map(
      (scenario) => ({ storageMode, scenario }),
    ),
  ),
)(
  "retains $storageMode send ownership while preparing transport ($scenario)",
  async ({ storageMode, scenario }) => {
    const sessionKey = "agent:main:send-preparation";
    const item = queued("prepared-send", "Send after transport preparation", 1, "waiting-idle", {
      sessionKey,
      agentId: "main",
      sendAttempts: 0,
    });
    const host = makeChatHost({
      sessionKey,
      currentSessionId: "send-preparation-session",
      chatQueue: storageMode === "durable" ? [item] : [],
      requestHandlers: { "chat.send": { status: "ok", messageSeq: 1 } },
    });
    if (storageMode === "durable") {
      admitHostQueueItems(host);
    } else {
      keepVolatileQueuedMessage(host, sessionKey, item);
    }
    const ready = createDeferred();
    const requested = createDeferred();
    const previousError = host.chatError;
    vi.doMock("./chat-send-delivery.runtime.ts", async (importOriginal) => {
      requested.resolve();
      await ready.promise;
      return importOriginal<typeof import("./chat-send-delivery.runtime.ts")>();
    });
    let canDispatch = true;
    const sending = sendQueuedChatMessage(host, item.id, {
      storageMode,
      canDispatch: () => canDispatch,
    });
    const expectQueued = (fields: Partial<ChatQueueItem>) =>
      expect(readQueuedMessageById(host, item.id)).toMatchObject({
        text: item.text,
        sendAttempts: 0,
        ...fields,
      });
    try {
      await requested.promise;
      expectNoRpc(host.request, "chat.send");
      expectQueued({});
      if (scenario === "connection replaced") {
        host.connectionEpoch += 1;
      } else if (scenario === "row replaced") {
        updateQueuedMessage(host, item.id, (current) => ({
          ...current,
          text: "Newer queued text",
        }));
      } else if (scenario === "cancelled") {
        canDispatch = false;
      }
      if (scenario === "ready") {
        ready.resolve();
      } else {
        ready.reject(new Error("Synthetic transport unavailable"));
      }
      const result = await sending;
      if (scenario === "ready") {
        expect(result).toBe("sent");
        expect(findChatSendPayload(host)).toMatchObject({ sessionKey, message: item.text });
      } else {
        expectNoRpc(host.request, "chat.send");
        const pending = scenario === "connection replaced" || scenario === "row replaced";
        const error =
          scenario === "cancelled"
            ? INTERRUPTED_SETTINGS_WAIT_ERROR
            : expect.stringContaining("Synthetic transport unavailable");
        expect(result).toBe(pending ? "pending" : "failed");
        expectQueued({
          text: scenario === "row replaced" ? "Newer queued text" : item.text,
          sendState: pending ? "waiting-idle" : "failed",
          ...(!pending ? { sendError: error } : {}),
        });
        expect(host.chatError).toEqual(pending ? previousError : error);
        if (!pending) {
          expect(host.lastError).toEqual(error);
        }
      }
    } finally {
      ready.resolve();
      await sending;
      host.sessions.dispose();
    }
  },
);

it.each(["pending", "failed"] as const)("sends with a %s streaming formatter", async (state) => {
  const ready = createDeferred();
  prepareStreaming.mockImplementationOnce(() => ready.promise);
  if (state === "failed") {
    ready.reject(new Error("Streaming formatter unavailable"));
  }
  const sessionKey = "agent:main:send-preparation";
  const item = queued("formatter-send", "Send once", 1, "waiting-idle", {
    sessionKey,
    agentId: "main",
    sendAttempts: 0,
  });
  const host = makeChatHost({
    sessionKey,
    currentSessionId: "formatter-session",
    chatQueue: [item],
    requestHandlers: { "chat.send": { status: "ok", messageSeq: 1 } },
  });
  admitHostQueueItems(host);
  let result: string | undefined;
  const sending = sendQueuedChatMessage(host, item.id, {}, sessionKey).then((sent) => {
    result = sent;
  });
  try {
    await expect.poll(() => result, { timeout: 5_000 }).toBe("sent");
    expect(findChatSendPayload(host)).toMatchObject({ sessionKey, message: item.text });
  } finally {
    ready.resolve();
    await sending;
    host.sessions.dispose();
  }
});
