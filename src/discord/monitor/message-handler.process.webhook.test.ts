import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";

const reactMessageDiscord = vi.fn(async () => {});
const removeReactionDiscord = vi.fn(async () => {});
const deliverDiscordReply = vi.fn(async () => {});
const getOrCreateWebhook = vi.fn(async () => null);
const sendWebhookMessage = vi.fn(async () => {});

vi.mock("../send.js", () => ({
  reactMessageDiscord: (...args: unknown[]) => reactMessageDiscord(...args),
  removeReactionDiscord: (...args: unknown[]) => removeReactionDiscord(...args),
}));

vi.mock("./reply-delivery.js", () => ({
  deliverDiscordReply: (...args: unknown[]) => deliverDiscordReply(...args),
}));

vi.mock("../webhook-cache.js", () => ({
  getOrCreateWebhook: (...args: unknown[]) => getOrCreateWebhook(...args),
}));

vi.mock("../send.webhook.js", () => ({
  sendWebhookMessage: (...args: unknown[]) => sendWebhookMessage(...args),
}));

vi.mock("../../auto-reply/reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: vi.fn(async ({ dispatcher }) => {
    dispatcher.sendFinalReply({ text: "hello" });
    return {
      queuedFinal: true,
      counts: { final: 1, tool: 0, block: 0 },
    };
  }),
}));

const { processDiscordMessage } = await import("./message-handler.process.js");

beforeEach(() => {
  reactMessageDiscord.mockClear();
  removeReactionDiscord.mockClear();
  deliverDiscordReply.mockClear();
  getOrCreateWebhook.mockClear();
  sendWebhookMessage.mockClear();
});

describe("processDiscordMessage webhook delivery", () => {
  it("uses webhook delivery for broadcast agents and skips responsePrefix", async () => {
    const ctx = await createBaseDiscordMessageContext();
    ctx.cfg.messages = { ...ctx.cfg.messages, responsePrefix: "PFX" };
    getOrCreateWebhook.mockResolvedValueOnce({ id: "wh_1", token: "tok_1" });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any, {
      agentIdentity: {
        name: "Coder",
        emoji: "💻",
        avatar: "https://example.com/avatar.png",
      },
    });

    expect(getOrCreateWebhook).toHaveBeenCalledWith("c1", {});
    expect(sendWebhookMessage).toHaveBeenCalledTimes(1);
    expect(sendWebhookMessage).toHaveBeenCalledWith(
      "wh_1",
      "tok_1",
      "hello",
      expect.objectContaining({
        username: "Coder 💻",
        avatarUrl: "https://example.com/avatar.png",
      }),
    );
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("falls back to default delivery (with responsePrefix) when webhook creation fails", async () => {
    const ctx = await createBaseDiscordMessageContext();
    ctx.cfg.messages = { ...ctx.cfg.messages, responsePrefix: "PFX" };
    getOrCreateWebhook.mockResolvedValueOnce(null);

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any, {
      agentIdentity: {
        name: "Coder",
      },
    });

    expect(sendWebhookMessage).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    const call = deliverDiscordReply.mock.calls[0]?.[0] as { replies?: Array<{ text?: string }> };
    expect(call.replies?.[0]?.text ?? "").toMatch(/^PFX /);
  });
});
