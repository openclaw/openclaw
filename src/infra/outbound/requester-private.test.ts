import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/outbound.types.js";
import { sendRequesterPrivateMessage } from "./requester-private.js";

const loadOutbound = vi.hoisted(() => vi.fn());
vi.mock("../../channels/plugins/outbound/load.js", () => ({
  loadChannelOutboundAdapter: loadOutbound,
}));

describe("sendRequesterPrivateMessage", () => {
  const request = {
    cfg: {},
    channel: "private-chat",
    accountId: "work-bot",
    senderId: "alice",
    text: "https://example.test/authorize?state=private-fixture",
    assertActive: () => {},
  };

  beforeEach(() => loadOutbound.mockReset());

  it("sends only through the private capability with the originating account and sender", async () => {
    const sendPrivateText = vi.fn(async () => ({ channel: "private-chat", messageId: "sent-1" }));
    const sendText = vi.fn();
    loadOutbound.mockResolvedValue({ sendPrivateText, sendText });

    await expect(sendRequesterPrivateMessage(request)).resolves.toEqual({ status: "sent" });
    expect(sendPrivateText).toHaveBeenCalledWith({
      cfg: request.cfg,
      accountId: "work-bot",
      senderId: "alice",
      text: request.text,
      assertActive: request.assertActive,
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does not fall back to ordinary sends when private delivery is unsupported", async () => {
    const sendText = vi.fn();
    loadOutbound.mockResolvedValue({ sendText });

    await expect(sendRequesterPrivateMessage(request)).resolves.toEqual({ status: "unsupported" });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does not treat missing registration as an unsupported capability", async () => {
    loadOutbound.mockResolvedValue(undefined);
    await expect(sendRequesterPrivateMessage(request)).resolves.toEqual({ status: "unavailable" });
  });

  it("allows the existing unsupported-channel flow without inventing a bot account", async () => {
    loadOutbound.mockResolvedValue({ sendText: vi.fn() });
    await expect(
      sendRequesterPrivateMessage({ ...request, accountId: undefined }),
    ).resolves.toEqual({
      status: "unsupported",
    });
  });

  it("requires the originating account for a private-capable channel", async () => {
    const sendPrivateText = vi.fn();
    loadOutbound.mockResolvedValue({ sendPrivateText });
    await expect(
      sendRequesterPrivateMessage({ ...request, accountId: undefined }),
    ).resolves.toEqual({
      status: "unavailable",
    });
    expect(sendPrivateText).not.toHaveBeenCalled();
  });

  it("redacts provider errors and never retries through the ordinary send path", async () => {
    const sendText = vi.fn();
    const sendPrivateText = vi.fn().mockRejectedValue(new Error(request.text));
    loadOutbound.mockResolvedValue({ sendPrivateText, sendText });

    await expect(sendRequesterPrivateMessage(request)).resolves.toEqual({ status: "failed" });
    expect(sendPrivateText).toHaveBeenCalledOnce();
    expect(sendText).not.toHaveBeenCalled();
  });

  it.each(["channel", "senderId"] as const)(
    "does not choose a default when %s is missing",
    async (key) => {
      await expect(sendRequesterPrivateMessage({ ...request, [key]: "" })).resolves.toEqual({
        status: "unavailable",
      });
      expect(loadOutbound).not.toHaveBeenCalled();
    },
  );

  it("rejects a run revoked while the adapter was loading", async () => {
    let active = true;
    const sendPrivateText = vi.fn();
    loadOutbound.mockImplementation(async () => {
      active = false;
      return { sendPrivateText };
    });

    await expect(
      sendRequesterPrivateMessage({
        ...request,
        assertActive: () => {
          if (!active) {
            throw new Error("Run closed");
          }
        },
      }),
    ).resolves.toEqual({ status: "failed" });
    expect(sendPrivateText).not.toHaveBeenCalled();
  });

  it.each([
    { channel: "private-chat", messageId: "" },
    { channel: "private-chat", messageId: "not-posted", outcome: "not_sent" as const },
  ])("does not claim success without acknowledged delivery: %j", async (result) => {
    const sendPrivateText: ChannelOutboundAdapter["sendPrivateText"] = async () => result;
    loadOutbound.mockResolvedValue({ sendPrivateText });

    await expect(sendRequesterPrivateMessage(request)).resolves.toEqual({ status: "failed" });
  });
});
