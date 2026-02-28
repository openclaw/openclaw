import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { createSignalEventHandler } from "./event-handler.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";

const sendMessageSignalMock = vi.hoisted(() => vi.fn());
const sendTypingSignalMock = vi.hoisted(() => vi.fn());
const sendReadReceiptSignalMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageSignal: (...args: unknown[]) => sendMessageSignalMock(...args),
  sendTypingSignal: (...args: unknown[]) => sendTypingSignalMock(...args),
  sendReadReceiptSignal: (...args: unknown[]) => sendReadReceiptSignalMock(...args),
}));

const dispatchMock = vi.hoisted(() =>
  vi.fn(async (params: { replyOptions?: { onReplyStart?: () => void | Promise<void> } }) => {
    await Promise.resolve(params.replyOptions?.onReplyStart?.());
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  }),
);

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchMock,
    dispatchInboundMessageWithDispatcher: dispatchMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchMock,
  };
});

const upsertMock = vi.hoisted(() => vi.fn().mockResolvedValue({ created: true, code: "ABCD" }));
vi.mock("../../pairing/pairing-store.js", () => ({
  upsertChannelPairingRequest: (...args: unknown[]) => upsertMock(...args),
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../pairing/pairing-messages.js", () => ({
  buildPairingReply: vi.fn().mockReturnValue("pair reply"),
}));

describe("signal suppressOutbound guards", () => {
  beforeEach(() => {
    sendMessageSignalMock.mockReset();
    sendTypingSignalMock.mockReset();
    sendReadReceiptSignalMock.mockReset();
    upsertMock.mockClear();
  });

  describe("read receipts", () => {
    it("blocks read receipts when suppressed", async () => {
      const handler = createSignalEventHandler(
        createBaseSignalEventHandlerDeps({
          cfg: {
            messages: { inbound: { debounceMs: 0 } },
            channels: { signal: { suppressOutbound: true } },
          } as OpenClawConfig,
          sendReadReceipts: true,
          readReceiptsViaDaemon: false,
          account: "+15550009999",
        }),
      );

      await handler(
        createSignalReceiveEvent({
          dataMessage: { message: "hello", timestamp: 1700000000000 },
        }),
      );

      expect(sendReadReceiptSignalMock).not.toHaveBeenCalled();
    });

    it("allows read receipts when not suppressed", async () => {
      const handler = createSignalEventHandler(
        createBaseSignalEventHandlerDeps({
          cfg: {
            messages: { inbound: { debounceMs: 0 } },
            channels: { signal: {} },
          } as OpenClawConfig,
          sendReadReceipts: true,
          readReceiptsViaDaemon: false,
          account: "+15550009999",
        }),
      );

      await handler(
        createSignalReceiveEvent({
          dataMessage: { message: "hello", timestamp: 1700000000000 },
        }),
      );

      expect(sendReadReceiptSignalMock).toHaveBeenCalledWith(
        "signal:+15550001111",
        1700000000000,
        expect.any(Object),
      );
    });
  });

  describe("typing indicators", () => {
    it("blocks typing signal when suppressed", async () => {
      const handler = createSignalEventHandler(
        createBaseSignalEventHandlerDeps({
          cfg: {
            messages: { inbound: { debounceMs: 0 } },
            channels: { signal: { suppressOutbound: true } },
          } as OpenClawConfig,
          account: "+15550009999",
        }),
      );

      await handler(
        createSignalReceiveEvent({
          dataMessage: { message: "hello", timestamp: 1700000000000 },
        }),
      );

      expect(sendTypingSignalMock).not.toHaveBeenCalled();
    });

    it("allows typing signal when not suppressed", async () => {
      const handler = createSignalEventHandler(
        createBaseSignalEventHandlerDeps({
          cfg: {
            messages: { inbound: { debounceMs: 0 } },
            channels: { signal: {} },
          } as OpenClawConfig,
          account: "+15550009999",
          blockStreaming: false,
        }),
      );

      await handler(
        createSignalReceiveEvent({
          dataMessage: { message: "hello", timestamp: 1700000000000 },
        }),
      );

      expect(sendTypingSignalMock).toHaveBeenCalledWith("+15550001111", expect.any(Object));
    });
  });
});
