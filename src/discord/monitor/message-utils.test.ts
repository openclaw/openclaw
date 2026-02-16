import type { Message } from "@buape/carbon";
import { describe, expect, it } from "vitest";
import { resolveDiscordMessageChannelId } from "./message-utils.js";

function asMessage(payload: Record<string, unknown>): Message {
  return payload as unknown as Message;
}

describe("resolveDiscordMessageChannelId", () => {
  it("uses message.channelId when present", () => {
    const channelId = resolveDiscordMessageChannelId({
      message: asMessage({ channelId: " 123 " }),
    });
    expect(channelId).toBe("123");
  });

  it("falls back to message.channel_id", () => {
    const channelId = resolveDiscordMessageChannelId({
      message: asMessage({ channel_id: " 234 " }),
    });
    expect(channelId).toBe("234");
  });

  it("falls back to message.rawData.channel_id", () => {
    const channelId = resolveDiscordMessageChannelId({
      message: asMessage({ rawData: { channel_id: "456" } }),
    });
    expect(channelId).toBe("456");
  });

  it("falls back to eventChannelId and coerces numeric values", () => {
    const channelId = resolveDiscordMessageChannelId({
      message: asMessage({}),
      eventChannelId: 789,
    });
    expect(channelId).toBe("789");
  });
});
