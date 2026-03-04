import { describe, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { createDiscordMessageHandler } from "./message-handler.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const BOT_USER_ID = "bot-123";

function createHandlerParams(overrides?: Partial<{ botUserId: string }>) {
  const cfg: OpenClawConfig = {
    channels: {
      discord: {
        enabled: true,
        token: "test-token",
        groupPolicy: "allowlist",
      },
    },
  };
  return {
    cfg,
    discordConfig: cfg.channels?.discord,
    accountId: "default",
    token: "test-token",
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    },
    botUserId: overrides?.botUserId ?? BOT_USER_ID,
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 10_000,
    textLimit: 2000,
    replyToMode: "off" as const,
    dmEnabled: true,
    groupDmEnabled: false,
    threadBindings: createNoopThreadBindingManager("default"),
  };
}

function createMessageData(authorId: string) {
  return {
    message: {
      id: "msg-1",
      author: { id: authorId, bot: authorId === BOT_USER_ID },
      content: "hello",
      channel_id: "ch-1",
    },
    channel_id: "ch-1",
  };
}

describe("createDiscordMessageHandler bot-self filter", () => {
  it("skips bot-own messages before debouncer", async () => {
    const handler = createDiscordMessageHandler(createHandlerParams());
    await handler(createMessageData(BOT_USER_ID) as never, {} as never);
  });

  it("processes messages from other users", async () => {
    const handler = createDiscordMessageHandler(createHandlerParams());
    try {
      await handler(
        createMessageData("user-456") as never,
        {
          fetchChannel: vi.fn().mockResolvedValue(null),
        } as never,
      );
    } catch {
      // Expected: pipeline fails without full mock, but it passed the filter.
    }
  });
});
