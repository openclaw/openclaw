import { beforeEach, describe, expect, it, vi } from "vitest";

const sendTypingMock = vi.fn();
const sendReadReceiptMock = vi.fn();

vi.mock("./send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: (...args: unknown[]) => sendTypingMock(...args),
  sendReadReceiptSignal: (...args: unknown[]) => sendReadReceiptMock(...args),
}));

vi.mock("../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/dispatch.js")>();
  const dispatchInboundMessage = vi.fn(
    async (params: { replyOptions?: { onReplyStart?: () => void } }) => {
      await Promise.resolve(params.replyOptions?.onReplyStart?.());
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    },
  );
  return {
    ...actual,
    dispatchInboundMessage,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessage,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessage,
  };
});

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

describe("signal event handler typing + read receipts", () => {
  beforeEach(() => {
    vi.useRealTimers();
    sendTypingMock.mockReset().mockResolvedValue(true);
    sendReadReceiptMock.mockReset().mockResolvedValue(true);
  });

  it("sends typing + read receipt for allowed DMs", async () => {
    vi.resetModules();
    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler({
      // oxlint-disable-next-line typescript/no-explicit-any
      runtime: { log: () => {}, error: () => {} } as any,
      cfg: {
        messages: { inbound: { debounceMs: 0 } },
        channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any,
      baseUrl: "http://localhost",
      account: "+15550009999",
      accountId: "default",
      blockStreaming: false,
      historyLimit: 0,
      groupHistories: new Map(),
      textLimit: 4000,
      dmPolicy: "open",
      allowFrom: ["*"],
      groupAllowFrom: ["*"],
      groupPolicy: "open",
      reactionMode: "off",
      reactionAllowlist: [],
      mediaMaxBytes: 1024,
      ignoreAttachments: true,
      sendReadReceipts: true,
      readReceiptsViaDaemon: false,
      fetchAttachment: async () => null,
      deliverReplies: async () => {},
      resolveSignalReactionTargets: () => [],
      // oxlint-disable-next-line typescript/no-explicit-any
      isSignalReactionMessage: () => false as any,
      shouldEmitSignalReactionNotification: () => false,
      buildSignalReactionSystemEventText: () => "reaction",
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Alice",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hi",
          },
        },
      }),
    });

    expect(sendTypingMock).toHaveBeenCalledWith("signal:+15550001111", expect.any(Object));
    expect(sendReadReceiptMock).toHaveBeenCalledWith(
      "signal:+15550001111",
      1700000000000,
      expect.any(Object),
    );
  });
});
