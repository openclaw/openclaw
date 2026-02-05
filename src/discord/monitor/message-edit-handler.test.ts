import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordMessageUpdateEvent } from "./listeners.js";

const mocks = vi.hoisted(() => ({
  preflightDiscordMessage: vi.fn(async () => null),
  processDiscordMessage: vi.fn(async () => {}),
  abortEmbeddedPiRun: vi.fn(() => false),
  clearSessionQueues: vi.fn(),
  clearInboundDedupeKey: vi.fn(() => false),
  resolveAgentRoute: vi.fn(() => ({
    sessionKey: "agent:main:discord:channel:ch-1",
    agentId: "main",
    channel: "discord",
    accountId: "acc-1",
    mainSessionKey: "agent:main:main",
  })),
  resolveDiscordMessageText: vi.fn(
    (message: { content?: string }) => message?.content?.trim() ?? "",
  ),
}));

vi.mock("./message-handler.preflight.js", () => ({
  preflightDiscordMessage: mocks.preflightDiscordMessage,
}));
vi.mock("./message-handler.process.js", () => ({
  processDiscordMessage: mocks.processDiscordMessage,
}));
vi.mock("../../agents/pi-embedded-runner/runs.js", () => ({
  abortEmbeddedPiRun: mocks.abortEmbeddedPiRun,
}));
vi.mock("../../auto-reply/reply/queue.js", () => ({
  clearSessionQueues: mocks.clearSessionQueues,
}));
vi.mock("../../auto-reply/reply/inbound-dedupe.js", () => ({
  clearInboundDedupeKey: mocks.clearInboundDedupeKey,
}));
vi.mock("../../routing/resolve-route.js", () => ({
  resolveAgentRoute: mocks.resolveAgentRoute,
}));
vi.mock("./message-utils.js", () => ({
  resolveDiscordMessageText: mocks.resolveDiscordMessageText,
}));

const { createDiscordMessageEditHandler } = await import("./message-edit-handler.js");

function buildEditEvent(overrides?: {
  authorId?: string;
  authorBot?: boolean;
  messageId?: string;
  content?: string;
  editedTimestamp?: string | null;
  channelId?: string;
  guildId?: string;
}): DiscordMessageUpdateEvent {
  const authorId = overrides?.authorId ?? "user-1";
  const hasEditedTimestamp = overrides?.editedTimestamp !== null;
  return {
    guild_id: overrides?.guildId ?? "guild-1",
    guild: overrides?.guildId !== undefined ? ({ id: overrides.guildId } as never) : undefined,
    message: {
      id: overrides?.messageId ?? "msg-1",
      channelId: overrides?.channelId ?? "ch-1",
      content: overrides?.content ?? "edited text",
      author: {
        id: authorId,
        bot: overrides?.authorBot ?? false,
        username: "testuser",
      },
      rawData: hasEditedTimestamp
        ? { edited_timestamp: overrides?.editedTimestamp ?? "2026-02-05T00:00:00Z" }
        : {},
    } as never,
  } as unknown as DiscordMessageUpdateEvent;
}

function createHandler(overrides?: { botUserId?: string }) {
  return createDiscordMessageEditHandler({
    cfg: {} as never,
    discordConfig: {} as never,
    accountId: "acc-1",
    token: "tok",
    runtime: { log: vi.fn(), error: vi.fn() },
    botUserId: overrides?.botUserId ?? "bot-1",
    guildHistories: new Map(),
    historyLimit: 20,
    mediaMaxBytes: 8 * 1024 * 1024,
    textLimit: 2000,
    replyToMode: "off",
    dmEnabled: true,
    groupDmEnabled: false,
  });
}

describe("createDiscordMessageEditHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAgentRoute.mockReturnValue({
      sessionKey: "agent:main:discord:channel:ch-1",
      agentId: "main",
      channel: "discord",
      accountId: "acc-1",
      mainSessionKey: "agent:main:main",
    });
    mocks.resolveDiscordMessageText.mockImplementation(
      (message: { content?: string }) => message?.content?.trim() ?? "",
    );
  });

  it("ignores edits from the bot itself", async () => {
    const handler = createHandler({ botUserId: "bot-1" });
    const event = buildEditEvent({ authorId: "bot-1" });
    await handler(event, {} as never);
    expect(mocks.preflightDiscordMessage).not.toHaveBeenCalled();
  });

  it("ignores edits from other bots", async () => {
    const handler = createHandler();
    const event = buildEditEvent({ authorBot: true });
    await handler(event, {} as never);
    expect(mocks.preflightDiscordMessage).not.toHaveBeenCalled();
  });

  it("ignores events without edited_timestamp (embed unfurls)", async () => {
    const handler = createHandler();
    const event = buildEditEvent({ editedTimestamp: null });
    await handler(event, {} as never);
    expect(mocks.preflightDiscordMessage).not.toHaveBeenCalled();
  });

  it("ignores edits with empty content", async () => {
    const handler = createHandler();
    mocks.resolveDiscordMessageText.mockReturnValueOnce("");
    const event = buildEditEvent({ content: "" });
    await handler(event, {} as never);
    expect(mocks.preflightDiscordMessage).not.toHaveBeenCalled();
  });

  it("aborts in-progress run and re-processes through preflight + process", async () => {
    mocks.preflightDiscordMessage.mockResolvedValueOnce({ fake: "ctx" } as never);
    mocks.abortEmbeddedPiRun.mockReturnValueOnce(true);
    const handler = createHandler();
    const event = buildEditEvent();
    await handler(event, {} as never);

    expect(mocks.abortEmbeddedPiRun).toHaveBeenCalledWith("agent:main:discord:channel:ch-1");
    expect(mocks.clearSessionQueues).toHaveBeenCalledWith(["agent:main:discord:channel:ch-1"]);
    expect(mocks.clearInboundDedupeKey).toHaveBeenCalledWith(
      expect.objectContaining({
        Provider: "discord",
        MessageSid: "msg-1",
      }),
    );
    expect(mocks.preflightDiscordMessage).toHaveBeenCalledTimes(1);
    expect(mocks.processDiscordMessage).toHaveBeenCalledWith({ fake: "ctx" });
  });

  it("does not call processDiscordMessage when preflight returns null", async () => {
    mocks.preflightDiscordMessage.mockResolvedValueOnce(null);
    const handler = createHandler();
    const event = buildEditEvent();
    await handler(event, {} as never);

    expect(mocks.preflightDiscordMessage).toHaveBeenCalledTimes(1);
    expect(mocks.processDiscordMessage).not.toHaveBeenCalled();
  });

  it("bridges author from message to synthetic event data", async () => {
    mocks.preflightDiscordMessage.mockResolvedValueOnce(null);
    const handler = createHandler();
    const event = buildEditEvent({ authorId: "user-42" });
    await handler(event, {} as never);

    const call = mocks.preflightDiscordMessage.mock.calls[0]?.[0];
    expect(call?.data?.author?.id).toBe("user-42");
  });
});
