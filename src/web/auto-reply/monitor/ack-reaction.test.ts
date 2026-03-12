import { beforeEach, describe, expect, it, vi } from "vitest";

const sendReactionWhatsAppMock = vi.fn(async (..._args: unknown[]) => {});
const resolveGroupActivationForMock = vi.fn(() => null as "always" | "mentions" | null);

vi.mock("../../outbound.js", () => ({
  sendReactionWhatsApp: (
    chatJid: string,
    messageId: string,
    emoji: string,
    options: {
      verbose: boolean;
      fromMe?: boolean;
      participant?: string;
      accountId?: string;
    },
  ) => sendReactionWhatsAppMock(chatJid, messageId, emoji, options),
}));

vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: () => resolveGroupActivationForMock(),
}));

import { maybeSendAckReaction, resolveWhatsAppAckReactionDecision } from "./ack-reaction.js";

type Config = ReturnType<typeof import("../../../config/config.js").loadConfig>;

function makeCfg(overrides?: {
  emoji?: string;
  direct?: boolean;
  group?: "always" | "mentions" | "never";
}): Config {
  return {
    channels: {
      whatsapp: {
        ackReaction: {
          emoji: overrides?.emoji ?? "👀",
          direct: overrides?.direct ?? true,
          group: overrides?.group ?? "mentions",
        },
      },
    },
  } as unknown as Config;
}

function makeDirectMsg(overrides?: Partial<import("../types.js").WebInboundMsg>) {
  return {
    id: "msg-1",
    from: "+15550001",
    conversationId: "+15550001",
    to: "+15550002",
    accountId: "default",
    body: "hello",
    chatType: "direct",
    chatId: "direct:+15550001",
    sendComposing: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    sendMedia: vi.fn(async () => {}),
    ...overrides,
  } as import("../types.js").WebInboundMsg;
}

function makeGroupMsg(overrides?: Partial<import("../types.js").WebInboundMsg>) {
  return {
    id: "group-msg-1",
    from: "123@g.us",
    conversationId: "123@g.us",
    to: "+15550002",
    accountId: "default",
    body: "@bot hello",
    chatType: "group",
    chatId: "123@g.us",
    senderJid: "15550001@s.whatsapp.net",
    senderE164: "+15550001",
    wasMentioned: false,
    sendComposing: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    sendMedia: vi.fn(async () => {}),
    ...overrides,
  } as import("../types.js").WebInboundMsg;
}

describe("resolveWhatsAppAckReactionDecision", () => {
  beforeEach(() => {
    sendReactionWhatsAppMock.mockClear();
    resolveGroupActivationForMock.mockReset();
    resolveGroupActivationForMock.mockReturnValue(null);
  });

  it("enables direct reaction when direct ack is enabled", () => {
    const decision = resolveWhatsAppAckReactionDecision({
      cfg: makeCfg({ direct: true }),
      msg: makeDirectMsg(),
      agentId: "main",
      sessionKey: "agent:main:whatsapp:direct:+15550001",
      conversationId: "+15550001",
      accountId: "default",
    });

    expect(decision.shouldReact).toBe(true);
    expect(decision.emoji).toBe("👀");
    expect(decision.target).toMatchObject({
      chatId: "direct:+15550001",
      messageId: "msg-1",
      accountId: "default",
    });
  });

  it("disables direct reaction when direct ack is disabled", () => {
    const decision = resolveWhatsAppAckReactionDecision({
      cfg: makeCfg({ direct: false }),
      msg: makeDirectMsg(),
      agentId: "main",
      sessionKey: "agent:main:whatsapp:direct:+15550001",
      conversationId: "+15550001",
      accountId: "default",
    });

    expect(decision.shouldReact).toBe(false);
    expect(decision.target).toBeNull();
  });

  it("honors group=always and group=never", () => {
    const always = resolveWhatsAppAckReactionDecision({
      cfg: makeCfg({ group: "always" }),
      msg: makeGroupMsg({ wasMentioned: false }),
      agentId: "main",
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      conversationId: "123@g.us",
      accountId: "default",
    });
    const never = resolveWhatsAppAckReactionDecision({
      cfg: makeCfg({ group: "never" }),
      msg: makeGroupMsg({ wasMentioned: true }),
      agentId: "main",
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      conversationId: "123@g.us",
      accountId: "default",
    });

    expect(always.shouldReact).toBe(true);
    expect(never.shouldReact).toBe(false);
  });

  it("allows mention-mode reaction via group activation bypass", () => {
    resolveGroupActivationForMock.mockReturnValue("always");
    const decision = resolveWhatsAppAckReactionDecision({
      cfg: makeCfg({ group: "mentions" }),
      msg: makeGroupMsg({ wasMentioned: false }),
      agentId: "main",
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      conversationId: "123@g.us",
      accountId: "default",
    });

    expect(decision.shouldReact).toBe(true);
    expect(decision.target?.chatId).toBe("123@g.us");
  });

  it("returns no reaction when inbound message id is missing", () => {
    const decision = resolveWhatsAppAckReactionDecision({
      cfg: makeCfg(),
      msg: makeDirectMsg({ id: undefined }),
      agentId: "main",
      sessionKey: "agent:main:whatsapp:direct:+15550001",
      conversationId: "+15550001",
      accountId: "default",
    });

    expect(decision.shouldReact).toBe(false);
    expect(decision.target).toBeNull();
  });
});

describe("maybeSendAckReaction", () => {
  beforeEach(() => {
    sendReactionWhatsAppMock.mockClear();
    resolveGroupActivationForMock.mockReset();
    resolveGroupActivationForMock.mockReturnValue(null);
  });

  it("sends one-shot reaction using resolved decision", async () => {
    const warn = vi.fn();
    maybeSendAckReaction({
      cfg: makeCfg(),
      msg: makeDirectMsg(),
      agentId: "main",
      sessionKey: "agent:main:whatsapp:direct:+15550001",
      conversationId: "+15550001",
      verbose: false,
      accountId: "default",
      info: () => {},
      warn,
    });

    await Promise.resolve();

    expect(sendReactionWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(sendReactionWhatsAppMock).toHaveBeenCalledWith(
      "direct:+15550001",
      "msg-1",
      "👀",
      expect.objectContaining({
        accountId: "default",
        fromMe: false,
      }),
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
