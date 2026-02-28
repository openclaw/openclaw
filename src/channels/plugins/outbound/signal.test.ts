import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { signalOutbound } from "./signal.js";

describe("signalOutbound", () => {
  const cfg: OpenClawConfig = {
    channels: {
      signal: {
        mediaMaxMb: 8,
        accounts: {
          work: {
            mediaMaxMb: 4,
          },
        },
      },
    },
  };

  it("passes account-scoped maxBytes for sendText", async () => {
    const sendSignal = vi.fn().mockResolvedValue({ messageId: "sig-text-1", timestamp: 123 });
    const sendText = signalOutbound.sendText;
    expect(sendText).toBeDefined();

    const result = await sendText!({
      cfg,
      to: "+15555550123",
      text: "hello",
      accountId: "work",
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith(
      "+15555550123",
      "hello",
      expect.objectContaining({
        accountId: "work",
        maxBytes: 4 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "signal", messageId: "sig-text-1", timestamp: 123 });
  });

  it("passes mediaUrl/mediaLocalRoots for sendMedia", async () => {
    const sendSignal = vi.fn().mockResolvedValue({ messageId: "sig-media-1", timestamp: 456 });
    const sendMedia = signalOutbound.sendMedia;
    expect(sendMedia).toBeDefined();

    const result = await sendMedia!({
      cfg,
      to: "+15555550124",
      text: "caption",
      mediaUrl: "https://example.com/file.jpg",
      mediaLocalRoots: ["/tmp/media"],
      accountId: "default",
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith(
      "+15555550124",
      "caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/file.jpg",
        mediaLocalRoots: ["/tmp/media"],
        accountId: "default",
        maxBytes: 8 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "signal", messageId: "sig-media-1", timestamp: 456 });
  });
});
