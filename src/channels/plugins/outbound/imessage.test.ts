import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { imessageOutbound } from "./imessage.js";

describe("imessageOutbound", () => {
  const baseCfg: OpenClawConfig = {
    channels: {
      imessage: {},
    },
  };

  const createMockSend = () =>
    vi.fn().mockResolvedValue({ messageId: "msg-123", chatId: "chat-456" });

  describe("markdown stripping", () => {
    it("does not strip markdown by default", async () => {
      const mockSend = createMockSend();
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
      const cfg: OpenClawConfig = {
        channels: {
          imessage: {
            markdown: { strip: true },
          },
        },
      };
      const text = "This is **bold** and *italic*";

      await imessageOutbound.sendText!({
        cfg,
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
      const cfg: OpenClawConfig = {
        channels: {
          imessage: {
            markdown: { strip: true },
          },
        },
      };

      await imessageOutbound.sendText!({
        cfg,
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
      const cfg: OpenClawConfig = {
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
        cfg,
        to: "+1234567890",
        text: "**bold**",
        accountId: "work",
        deps: { sendIMessage: mockSend },
      });

      expect(mockSend).toHaveBeenCalledWith("+1234567890", "bold", expect.any(Object));

      // With no account (uses channel default)
      mockSend.mockClear();
      await imessageOutbound.sendText!({
        cfg,
        to: "+1234567890",
        text: "**bold**",
        deps: { sendIMessage: mockSend },
      });

      expect(mockSend).toHaveBeenCalledWith("+1234567890", "**bold**", expect.any(Object));
    });

    it("strips markdown in media captions when enabled", async () => {
      const mockSend = createMockSend();
      const cfg: OpenClawConfig = {
        channels: {
          imessage: {
            markdown: { strip: true },
          },
        },
      };

      await imessageOutbound.sendMedia!({
        cfg,
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

    it("handles undefined caption in media sends", async () => {
      const mockSend = createMockSend();
      const cfg: OpenClawConfig = {
        channels: {
          imessage: {
            markdown: { strip: true },
          },
        },
      };

      await imessageOutbound.sendMedia!({
        cfg,
        to: "+1234567890",
        text: undefined as unknown as string,
        mediaUrl: "file:///path/to/image.jpg",
        deps: { sendIMessage: mockSend },
      });

      expect(mockSend).toHaveBeenCalledWith(
        "+1234567890",
        undefined,
        expect.objectContaining({ mediaUrl: "file:///path/to/image.jpg" }),
      );
    });
  });
});
