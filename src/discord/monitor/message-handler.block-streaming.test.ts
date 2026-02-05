import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GetReplyOptions } from "../../auto-reply/types.js";

let capturedReplyOptions: GetReplyOptions | undefined;

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  const dispatchInboundMessage = vi.fn(async (params: { replyOptions?: GetReplyOptions }) => {
    capturedReplyOptions = params.replyOptions;
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  });
  return {
    ...actual,
    dispatchInboundMessage,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessage,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessage,
  };
});

import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import { processDiscordMessage } from "./message-handler.process.js";

function createTestContext(
  overrides: Partial<DiscordMessagePreflightContext> = {},
): DiscordMessagePreflightContext {
  return {
    cfg: { messages: {}, session: { store: "/tmp/sessions.json" } },
    discordConfig: {},
    accountId: "default",
    token: "token",
    runtime: { log: () => {}, error: () => {} },
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 1024,
    textLimit: 4000,
    sender: { label: "user" },
    replyToMode: "off",
    ackReactionScope: "direct",
    groupPolicy: "open",
    data: { guild: null },
    client: { rest: {} },
    message: {
      id: "m1",
      channelId: "c1",
      timestamp: new Date().toISOString(),
      attachments: [],
    },
    author: {
      id: "U1",
      username: "alice",
      discriminator: "0",
      globalName: "Alice",
    },
    channelInfo: null,
    channelName: undefined,
    isGuildMessage: false,
    isDirectMessage: true,
    isGroupDm: false,
    commandAuthorized: true,
    baseText: "hi",
    messageText: "hi",
    wasMentioned: false,
    shouldRequireMention: false,
    canDetectMention: false,
    effectiveWasMentioned: false,
    threadChannel: null,
    threadParentId: undefined,
    threadParentName: undefined,
    threadParentType: undefined,
    threadName: undefined,
    displayChannelSlug: "",
    guildInfo: null,
    guildSlug: "",
    channelConfig: null,
    baseSessionKey: "agent:main:discord:dm:u1",
    route: {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:discord:dm:u1",
      mainSessionKey: "agent:main:main",
    },
    ...overrides,
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
}

describe("discord block streaming", () => {
  it("enables block streaming by default (disableBlockStreaming=false)", async () => {
    capturedReplyOptions = undefined;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-"));
    const storePath = path.join(dir, "sessions.json");

    const ctx = createTestContext({
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: {}, session: { store: storePath } } as any,
      discordConfig: undefined,
    });

    await processDiscordMessage(ctx);

    expect(capturedReplyOptions).toBeTruthy();
    // 🦀 Claw's patch: Block streaming should be enabled by default for Discord
    expect(capturedReplyOptions?.disableBlockStreaming).toBe(false);
  });

  it("respects explicit blockStreaming=true config", async () => {
    capturedReplyOptions = undefined;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-"));
    const storePath = path.join(dir, "sessions.json");

    const ctx = createTestContext({
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: {}, session: { store: storePath } } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      discordConfig: { blockStreaming: true } as any,
    });

    await processDiscordMessage(ctx);

    expect(capturedReplyOptions).toBeTruthy();
    expect(capturedReplyOptions?.disableBlockStreaming).toBe(false);
  });

  it("respects explicit blockStreaming=false config", async () => {
    capturedReplyOptions = undefined;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-"));
    const storePath = path.join(dir, "sessions.json");

    const ctx = createTestContext({
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: {}, session: { store: storePath } } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      discordConfig: { blockStreaming: false } as any,
    });

    await processDiscordMessage(ctx);

    expect(capturedReplyOptions).toBeTruthy();
    expect(capturedReplyOptions?.disableBlockStreaming).toBe(true);
  });
});
