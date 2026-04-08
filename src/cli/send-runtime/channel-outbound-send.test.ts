import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelOutboundRuntimeSend } from "./channel-outbound-send.js";

const mockSendText = vi.fn(async () => ({ messageId: "mid1" }));
const mockSendMedia = vi.fn(async () => ({ messageId: "mid2" }));

vi.mock("../../channels/plugins/outbound/load.js", () => ({
  loadChannelOutboundAdapter: vi.fn(async (channelId: string) => {
    if (channelId === "telegram") {
      return {
        sendText: mockSendText,
        sendMedia: mockSendMedia,
      };
    }
    if (channelId === "whatsapp") {
      return {
        sendText: mockSendText,
        // whatsapp has no sendMedia — should fall back to sendText
      };
    }
    return undefined;
  }),
}));

describe("createChannelOutboundRuntimeSend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls sendText when no mediaUrl is provided", async () => {
    const runtime = createChannelOutboundRuntimeSend({
      channelId: "telegram",
      unavailableMessage: "telegram unavailable",
    });
    await runtime.sendMessage("chat123", "hello world");
    expect(mockSendText).toHaveBeenCalledOnce();
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ to: "chat123", text: "hello world" }),
    );
    expect(mockSendMedia).not.toHaveBeenCalled();
  });

  it("calls sendMedia when mediaUrl is provided and sendMedia exists", async () => {
    const runtime = createChannelOutboundRuntimeSend({
      channelId: "telegram",
      unavailableMessage: "telegram unavailable",
    });
    await runtime.sendMessage("chat123", "hello world", {
      mediaUrl: "https://example.com/image.png",
    });
    expect(mockSendMedia).toHaveBeenCalledOnce();
    expect(mockSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat123",
        text: "hello world",
        mediaUrl: "https://example.com/image.png",
      }),
    );
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("falls back to sendText with mediaUrl preserved when sendMedia does not exist", async () => {
    const runtime = createChannelOutboundRuntimeSend({
      channelId: "whatsapp",
      unavailableMessage: "whatsapp unavailable",
    });
    await runtime.sendMessage("chat456", "hello", {
      mediaUrl: "https://example.com/doc.pdf",
    });
    expect(mockSendText).toHaveBeenCalledOnce();
    // mediaUrl is still forwarded in the fallback so adapters that handle it
    // inside sendText (even if non-standard) continue to receive it
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ to: "chat456", text: "hello", mediaUrl: "https://example.com/doc.pdf" }),
    );
  });
});
