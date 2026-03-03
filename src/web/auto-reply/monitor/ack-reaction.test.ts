import { describe, expect, it, vi } from "vitest";

const { sendReactionMock } = vi.hoisted(() => ({
  sendReactionMock: vi.fn(async () => {}),
}));

vi.mock("../../outbound.js", () => ({
  sendReactionWhatsApp: sendReactionMock,
}));

vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: () => null,
}));

import { maybeSendAckReaction } from "./ack-reaction.js";

function makeParams(cfg: Record<string, unknown>) {
  return {
    cfg,
    msg: {
      id: "msg-1",
      from: "+1555",
      to: "+2000",
      chatId: "15550001111@s.whatsapp.net",
      chatType: "direct",
      body: "hi",
      wasMentioned: false,
      conversationId: "+1555",
      accountId: "default",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    },
    agentId: "main",
    sessionKey: "agent:main:whatsapp:direct:+1555",
    conversationId: "+1555",
    verbose: false,
    accountId: "default",
    info: vi.fn(),
    warn: vi.fn(),
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
}

describe("maybeSendAckReaction suppressOutbound", () => {
  it("blocks ack reaction when suppressOutbound is active", () => {
    sendReactionMock.mockClear();
    maybeSendAckReaction(
      makeParams({
        channels: {
          whatsapp: {
            ackReaction: { emoji: "👍", direct: true },
            suppressOutbound: true,
          },
        },
      }),
    );
    expect(sendReactionMock).not.toHaveBeenCalled();
  });

  it("sends ack reaction when suppressOutbound is false", () => {
    sendReactionMock.mockClear();
    maybeSendAckReaction(
      makeParams({
        channels: {
          whatsapp: {
            ackReaction: { emoji: "👍", direct: true },
            suppressOutbound: false,
          },
        },
      }),
    );
    expect(sendReactionMock).toHaveBeenCalled();
  });
});
