import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reactMessageDiscord = vi.fn(async () => {});
const removeReactionDiscord = vi.fn(async () => {});

let capturedFetchImpl: unknown;
const fetchRemoteMediaSpy = vi.fn(async (opts: { fetchImpl?: unknown }) => {
  capturedFetchImpl = opts.fetchImpl;
  return { buffer: Buffer.from("img"), contentType: "image/png", fileName: "a.png" };
});

vi.mock("../send.js", () => ({
  reactMessageDiscord: (...args: unknown[]) => reactMessageDiscord(...args),
  removeReactionDiscord: (...args: unknown[]) => removeReactionDiscord(...args),
}));

vi.mock("../../auto-reply/reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: vi.fn(async () => ({
    queuedFinal: false,
    counts: { final: 0, tool: 0, block: 0 },
  })),
}));

vi.mock("../../auto-reply/reply/reply-dispatcher.js", () => ({
  createReplyDispatcherWithTyping: vi.fn(() => ({
    dispatcher: {
      sendToolResult: vi.fn(() => true),
      sendBlockReply: vi.fn(() => true),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    },
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  })),
}));

vi.mock("../../media/fetch.js", () => ({
  fetchRemoteMedia: (...args: unknown[]) =>
    fetchRemoteMediaSpy(...(args as [{ fetchImpl?: unknown }])),
}));

vi.mock("../../media/store.js", () => ({
  saveMediaBuffer: vi.fn(async () => ({
    path: "/tmp/saved.png",
    contentType: "image/png",
  })),
}));

const { processDiscordMessage } = await import("./message-handler.process.js");

async function createBaseContext(overrides: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-"));
  const storePath = path.join(dir, "sessions.json");
  return {
    cfg: { messages: { ackReaction: "👀" }, session: { store: storePath } },
    discordConfig: {},
    accountId: "default",
    token: "token",
    runtime: { log: () => {}, error: () => {} },
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 1024,
    textLimit: 4000,
    replyToMode: "off",
    ackReactionScope: "group-mentions",
    groupPolicy: "open",
    data: { guild: { id: "g1", name: "Guild" } },
    client: { rest: {} },
    message: {
      id: "m1",
      channelId: "c1",
      timestamp: new Date().toISOString(),
      attachments: [],
    },
    messageChannelId: "c1",
    author: {
      id: "U1",
      username: "alice",
      discriminator: "0",
      globalName: "Alice",
    },
    channelInfo: { name: "general" },
    channelName: "general",
    isGuildMessage: true,
    isDirectMessage: false,
    isGroupDm: false,
    commandAuthorized: true,
    baseText: "hi",
    messageText: "hi",
    wasMentioned: false,
    shouldRequireMention: true,
    canDetectMention: true,
    effectiveWasMentioned: true,
    shouldBypassMention: false,
    threadChannel: null,
    threadParentId: undefined,
    threadParentName: undefined,
    threadParentType: undefined,
    threadName: undefined,
    displayChannelSlug: "general",
    guildInfo: null,
    guildSlug: "guild",
    channelConfig: null,
    baseSessionKey: "agent:main:discord:guild:g1",
    route: {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:discord:guild:g1",
      mainSessionKey: "agent:main:main",
    },
    ...overrides,
  };
}

beforeEach(() => {
  reactMessageDiscord.mockClear();
  removeReactionDiscord.mockClear();
});

describe("processDiscordMessage ack reactions", () => {
  it("skips ack reactions for group-mentions when mentions are not required", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      sender: { label: "user" },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(reactMessageDiscord).not.toHaveBeenCalled();
  });

  it("sends ack reactions for mention-gated guild messages when mentioned", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: true,
      effectiveWasMentioned: true,
      sender: { label: "user" },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(reactMessageDiscord).toHaveBeenCalledWith("c1", "m1", "👀", { rest: {} });
  });

  it("uses preflight-resolved messageChannelId when message.channelId is missing", async () => {
    const ctx = await createBaseContext({
      message: {
        id: "m1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      messageChannelId: "fallback-channel",
      shouldRequireMention: true,
      effectiveWasMentioned: true,
      sender: { label: "user" },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(reactMessageDiscord).toHaveBeenCalledWith("fallback-channel", "m1", "👀", {
      rest: {},
    });
  });
});

describe("processDiscordMessage proxy fetch", () => {
  beforeEach(() => {
    fetchRemoteMediaSpy.mockClear();
    capturedFetchImpl = undefined;
  });

  it("threads proxyFetch from context into fetchRemoteMedia for attachments", async () => {
    const fakeFetch = vi.fn() as unknown as typeof fetch;
    const ctx = await createBaseContext({
      sender: { label: "user" },
      proxyFetch: fakeFetch,
      message: {
        id: "m2",
        channelId: "c1",
        timestamp: new Date().toISOString(),
        attachments: [
          {
            id: "att1",
            url: "https://cdn.discordapp.com/attachments/1/2/image.png",
            filename: "image.png",
            content_type: "image/png",
            size: 1024,
          },
        ],
      },
      messageText: "check this image",
      baseText: "check this image",
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(fetchRemoteMediaSpy).toHaveBeenCalledTimes(1);
    expect(capturedFetchImpl).toBe(fakeFetch);
  });

  it("passes undefined fetchImpl when proxyFetch is not set", async () => {
    capturedFetchImpl = "sentinel";
    const ctx = await createBaseContext({
      sender: { label: "user" },
      message: {
        id: "m3",
        channelId: "c1",
        timestamp: new Date().toISOString(),
        attachments: [
          {
            id: "att2",
            url: "https://cdn.discordapp.com/attachments/1/2/doc.pdf",
            filename: "doc.pdf",
            content_type: "application/pdf",
            size: 512,
          },
        ],
      },
      messageText: "here is a doc",
      baseText: "here is a doc",
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(fetchRemoteMediaSpy).toHaveBeenCalledTimes(1);
    expect(capturedFetchImpl).toBeUndefined();
  });
});
