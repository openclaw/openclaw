// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { INTERRUPTED_SETTINGS_WAIT_ERROR } from "../../lib/chat/outbox-store-codec.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitHostQueueItems } from "./chat-outbox-recovery.test-support.ts";
import {
  keepVolatileQueuedMessage,
  readQueuedMessageById,
  updateQueuedMessage,
} from "./chat-queue.ts";
import { sendQueuedChatMessage } from "./chat-send-delivery.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

const { prepareStreaming } = vi.hoisted(() => ({
  prepareStreaming: vi.fn<() => Promise<unknown>>(),
}));
vi.mock("../../components/markdown-live-loader.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/markdown-live-loader.ts")>()),
  loadStreamingMarkdown: prepareStreaming,
}));

useChatSendBrowserFixture();

it.each(
  (["durable", "memory"] as const).flatMap((storageMode) =>
    (["ready", "rejected", "connection replaced", "row replaced", "cancelled"] as const).map(
      (scenario) => ({ storageMode, scenario }),
    ),
  ),
)(
  "retains $storageMode send ownership while preparing the first reply ($scenario)",
  async ({ storageMode, scenario }) => {
    const sessionKey = "agent:main:send-preparation";
    const item: ChatQueueItem = {
      id: "prepared-send",
      text: "Send after reply preparation",
      createdAt: 1,
      sessionKey,
      agentId: "main",
      sendState: "waiting-idle",
      sendAttempts: 0,
    };
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
    prepareStreaming.mockImplementationOnce(() => {
      requested.resolve();
      return ready.promise;
    });
    let canDispatch = true;
    const sending = sendQueuedChatMessage(host, item.id, {
      storageMode,
      canDispatch: () => canDispatch,
    });
    try {
      await requested.promise;
      expect(host.request).not.toHaveBeenCalledWith(
        "chat.send",
        expect.anything(),
        expect.anything(),
      );
      expect(readQueuedMessageById(host, item.id)).toMatchObject({
        text: item.text,
        sendAttempts: 0,
      });
      if (scenario === "connection replaced") {
        host.connectionEpoch += 1;
      } else if (scenario === "row replaced") {
        expect(
          updateQueuedMessage(host, item.id, (current) => ({
            ...current,
            text: "Newer queued text",
          })),
        ).toMatchObject({ text: "Newer queued text" });
      } else if (scenario === "cancelled") {
        canDispatch = false;
      }
      if (scenario === "ready") {
        ready.resolve();
      } else {
        ready.reject(new Error("Synthetic reply preparation unavailable"));
      }
      const result = await sending;
      if (scenario === "ready") {
        expect(result).toBe("sent");
        expect(host.request).toHaveBeenCalledWith(
          "chat.send",
          expect.objectContaining({ sessionKey, message: item.text }),
          expect.anything(),
        );
        return;
      }
      expect(host.request).not.toHaveBeenCalledWith(
        "chat.send",
        expect.anything(),
        expect.anything(),
      );
      if (scenario === "rejected" || scenario === "cancelled") {
        const error =
          scenario === "cancelled"
            ? INTERRUPTED_SETTINGS_WAIT_ERROR
            : "Synthetic reply preparation unavailable";
        expect(result).toBe("failed");
        expect(readQueuedMessageById(host, item.id)).toMatchObject({
          text: item.text,
          sendAttempts: 0,
          sendState: "failed",
          sendError: error,
        });
        expect(host.chatError).toBe(error);
        expect(host.lastError).toBe(error);
      } else {
        expect(result).toBe("pending");
        expect(readQueuedMessageById(host, item.id)).toMatchObject({
          text: scenario === "row replaced" ? "Newer queued text" : item.text,
          sendAttempts: 0,
          sendState: "waiting-idle",
        });
        expect(host.chatError).toBe(previousError);
      }
    } finally {
      ready.resolve();
      await sending;
      host.sessions.dispose();
    }
  },
);
