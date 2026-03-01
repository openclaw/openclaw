import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("buildTelegramMessageContext suppressOutbound", () => {
  it("sets statusReactionController and ackReactionPromise to null when suppressed", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: { chat: { id: 123, type: "private" } },
      ackReactionScope: "all",
      cfg: {
        agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
        channels: { telegram: { suppressOutbound: true } },
        messages: { groupChat: { mentionPatterns: [] }, ackReaction: "👀" },
      },
    });

    expect(ctx!.statusReactionController).toBeNull();
    expect(ctx!.ackReactionPromise).toBeNull();
  });

  it("allows ackReactionPromise when not suppressed and ack enabled", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: { chat: { id: 123, type: "private" } },
      ackReactionScope: "all",
      cfg: {
        agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
        channels: { telegram: {} },
        messages: { groupChat: { mentionPatterns: [] }, ackReaction: "👀" },
      },
    });

    expect(ctx!.ackReactionPromise).not.toBeNull();
  });
});
