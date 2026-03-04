import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { imessageOutbound } from "./imessage.js";

describe("imessageOutbound", () => {
  const cfg: OpenClawConfig = {
    channels: {
      imessage: {
        mediaMaxMb: 2,
      },
    },
  };

  const createMockSend = () =>
    vi.fn().mockResolvedValue({ messageId: "msg-123", chatId: "chat-456" });

  it("passes replyToId through sendText", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "text-1" });
    const sendText = imessageOutbound.sendText;
    expect(sendText).toBeDefined();

    const result = await sendText!({
      cfg,
      to: "chat_id:123",
      text: "hello",
      accountId: "default",
      replyToId: "msg-123",
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:123",
      "hello",
      expect.objectContaining({
        replyToId: "msg-123",
        accountId: "default",
        maxBytes: 2 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "text-1" });
  });

  it("passes replyToId through sendMedia", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "media-1" });
    const sendMedia = imessageOutbound.sendMedia;
    expect(sendMedia).toBeDefined();

    const result = await sendMedia!({
      cfg,
      to: "chat_id:123",
      text: "caption",
      mediaUrl: "https://example.com/file.jpg",
      mediaLocalRoots: ["/tmp"],
      accountId: "acct-1",
      replyToId: "msg-456",
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:123",
      "caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/file.jpg",
        mediaLocalRoots: ["/tmp"],
        replyToId: "msg-456",
        accountId: "acct-1",
        maxBytes: 2 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "media-1" });
  });

  describe("markdown stripping", () => {
    it("does not strip markdown by default", async () => {
      const mockSend = createMockSend();
      const baseCfg: OpenClawConfig = {
        channels: {
          imessage: {},
        },
      };
      const text = "This is **bold** and *italic*";

      await imessageOutbound.sendText!({
        cfg: baseCfg,
        to: "+1234567890",
        text,
        deps: { sendIMessage: mockSend },
      });

      expect(mockSend).toHaveBeenCalledWith(
        "+1234567890",
        "This is **bold** and *italic*",
        expect.any(Object),
      );
    });

    it("strips markdown when markdown.strip is true", async () => {
      const mockSend = createMockSend();
      const stripCfg: OpenClawConfig = {
        channels: {
          imessage: {
            markdown: { strip: true },
          },
        },
      };
      const text = "This is **bold** and *italic*";

      await imessageOutbound.sendText!({
        cfg: stripCfg,
        to: "+1234567890",
        text,
        deps: { sendIMessage: mockSend },
      });

      expect(mockSend).toHaveBeenCalledWith(
        "+1234567890",
        "This is bold and italic",
        expect.any(Object),
      );
    });

    it("strips headers", async () => {
      const mockSend = createMockSend();
      const stripCfg: OpenClawConfig = {
        channels: {
          imessage: {
            markdown: { strip: true },
          },
        },
      };

      await imessageOutbound.sendText!({
        cfg: stripCfg,
        to: "+1234567890",
        text: "## Important Header\n\nSome text",
        deps: { sendIMessage: mockSend },
      });

      expect(mockSend).toHaveBeenCalledWith(
        "+1234567890",
        "Important Header\n\nSome text",
        expect.any(Object),
      );
    });

    it("respects per-account markdown.strip setting", async () => {
      const mockSend = createMockSend();
      const accountCfg: OpenClawConfig = {
        channels: {
          imessage: {
            markdown: { strip: false },
            accounts: {
              work: {
                markdown: { strip: true },
              },
            },
          },
        },
      };

      // With account that has strip enabled
      await imessageOutbound.sendText!({
        cfg: accountCfg,
        to: "+1234567890",
        text: "**bold**",
        accountId: "work",
        deps: { sendIMessage: mockSend },
      });

      expect(mockSend).toHaveBeenCalledWith("+1234567890", "bold", expect.any(Object));

      // With no account (uses channel default)
      mockSend.mockClear();
      await imessageOutbound.sendText!({
        cfg: accountCfg,
        to: "+1234567890",
        text: "**bold**",
        deps: { sendIMessage: mockSend },
      });

      expect(mockSend).toHaveBeenCalledWith("+1234567890", "**bold**", expect.any(Object));
    });

    it("strips markdown in media captions when enabled", async () => {
      const mockSend = createMockSend();
      const stripCfg: OpenClawConfig = {
        channels: {
          imessage: {
            markdown: { strip: true },
          },
        },
      };

      await imessageOutbound.sendMedia!({
        cfg: stripCfg,
        to: "+1234567890",
        text: "**Photo caption**",
        mediaUrl: "file:///path/to/image.jpg",
        deps: { sendIMessage: mockSend },
      });

      expect(mockSend).toHaveBeenCalledWith(
        "+1234567890",
        "Photo caption",
        expect.objectContaining({ mediaUrl: "file:///path/to/image.jpg" }),
      );
    });
  });
});
