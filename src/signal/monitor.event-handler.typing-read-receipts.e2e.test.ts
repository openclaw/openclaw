import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./monitor/event-handler.test-harness.js";

const sendTypingMock = vi.fn();
const sendReadReceiptMock = vi.fn();
const dispatchInboundMessageMock = vi.fn(
  async (params: { replyOptions?: { onReplyStart?: () => void } }) => {
    await Promise.resolve(params.replyOptions?.onReplyStart?.());
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  },
);

vi.mock("./send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: sendTypingMock,
  sendReadReceiptSignal: sendReadReceiptMock,
}));

vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: dispatchInboundMessageMock,
  dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
  dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

describe("signal event handler typing + read receipts", () => {
  beforeEach(() => {
    vi.useRealTimers();
    sendTypingMock.mockReset().mockResolvedValue(true);
    sendReadReceiptMock.mockReset().mockResolvedValue(true);
    dispatchInboundMessageMock.mockClear();
  });

  it("sends typing + read receipt for allowed DMs", async () => {
    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
        account: "+15550009999",
        blockStreaming: false,
        historyLimit: 0,
        groupHistories: new Map(),
        sendReadReceipts: true,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );

    expect(sendTypingMock).toHaveBeenCalledWith("signal:+15550001111", expect.any(Object));
    expect(sendReadReceiptMock).toHaveBeenCalledWith(
      "signal:+15550001111",
      1700000000000,
      expect.any(Object),
    );
  });
});
