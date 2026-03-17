import { beforeEach, describe, expect, it } from "vitest";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveTelegramConversationId } from "./telegram-context.js";

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
  );
});

describe("resolveTelegramConversationId", () => {
  it("builds canonical topic ids from chat target and message thread id", () => {
    const conversationId = resolveTelegramConversationId({
      ctx: {
        OriginatingTo: "-100200300",
        MessageThreadId: "77",
      },
      command: {},
    });
    expect(conversationId).toBe("-100200300:topic:77");
  });

  it("returns the direct-message chat id when no topic id is present", () => {
    const conversationId = resolveTelegramConversationId({
      ctx: {
        OriginatingTo: "123456",
      },
      command: {},
    });
    expect(conversationId).toBe("123456");
  });

  it("does not treat non-topic groups as globally bindable conversations", () => {
    const conversationId = resolveTelegramConversationId({
      ctx: {
        OriginatingTo: "-100200300",
      },
      command: {},
    });
    expect(conversationId).toBeUndefined();
  });

  it("falls back to command target when originating target is missing", () => {
    const conversationId = resolveTelegramConversationId({
      ctx: {
        To: "123456",
      },
      command: {
        to: "78910",
      },
    });
    expect(conversationId).toBe("78910");
  });
});
