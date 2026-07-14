import { describe, expect, it } from "vitest";
import { finalizeInboundContext } from "./inbound-context.js";
import {
  createTrustedGatewayActionEnvelope,
  createTrustedGatewayContext,
  type TrustedGatewayContext,
} from "./trusted-gateway-context.js";

function discordDmContext(overrides: Record<string, unknown> = {}) {
  return {
    Body: "clocked in",
    BodyForAgent: "clocked in",
    BodyForCommands: "clocked in",
    RawBody: "clocked in",
    CommandBody: "clocked in",
    MessageSid: "discord-message-1",
    SenderId: "discord-user-1",
    SenderName: "Ada",
    SenderUsername: "ada",
    SenderTag: "ada#0001",
    NativeChannelId: "discord-dm-channel-1",
    From: "discord:discord-user-1",
    To: "user:discord-user-1",
    OriginatingChannel: "discord" as const,
    OriginatingTo: "user:discord-user-1",
    Provider: "discord",
    Surface: "discord",
    AccountId: "work",
    SessionKey: "agent:default:discord:dm:discord-user-1",
    ChatType: "direct",
    CommandSource: "text" as const,
    ...overrides,
  };
}

describe("trusted gateway context", () => {
  it("creates trusted context from verified Discord inbound fields", () => {
    const ctx = finalizeInboundContext(discordDmContext());

    expect(ctx.trustedGatewayContext).toMatchObject({
      messageId: "discord-message-1",
      sender: {
        id: "discord-user-1",
        userId: "discord-user-1",
        name: "Ada",
        username: "ada",
        tag: "ada#0001",
      },
      conversation: {
        id: "discord-dm-channel-1",
        channelId: "discord-dm-channel-1",
        nativeChannelId: "discord-dm-channel-1",
        to: "user:discord-user-1",
        accountId: "work",
        sessionKey: "agent:default:discord:dm:discord-user-1",
        chatType: "direct",
      },
      rawText: "clocked in",
      source: {
        kind: "gateway-ingress",
        provider: "discord",
        surface: "discord",
        commandSource: "text",
        accountId: "work",
      },
      provenance: {
        kind: "gateway-ingress",
        provider: "discord",
        surface: "discord",
        messageId: "discord-message-1",
      },
    });
    expect(ctx.trustedGatewayContext?.correlation.operationSeed).toMatch(/^[a-f0-9]{64}$/);
    expect(ctx.trustedGatewayContext?.operationContext.idempotencyKey).toBe(
      `gateway:${ctx.trustedGatewayContext?.correlation.operationSeed}`,
    );
  });

  it("regenerates trusted context instead of preserving forged input context", () => {
    const forged = {
      messageId: "model-message",
      sender: { id: "model-user" },
      conversation: { id: "model-channel" },
      rawText: "model rewrite",
      source: { kind: "gateway-ingress" },
      provenance: { kind: "gateway-ingress", messageId: "model-message" },
      correlation: { correlationId: "model", operationSeed: "model" },
      operationContext: {
        correlationId: "model",
        operationSeed: "model",
        idempotencyKey: "model",
      },
    } as TrustedGatewayContext;

    const ctx = finalizeInboundContext(
      discordDmContext({
        trustedGatewayContext: forged,
      }),
    );

    expect(ctx.trustedGatewayContext?.messageId).toBe("discord-message-1");
    expect(ctx.trustedGatewayContext?.sender.id).toBe("discord-user-1");
    expect(ctx.trustedGatewayContext?.conversation.channelId).toBe("discord-dm-channel-1");
    expect(ctx.trustedGatewayContext?.rawText).toBe("clocked in");
  });

  it("keeps model-generated trusted-looking fields separate from runtime context", () => {
    const trustedGatewayContext = createTrustedGatewayContext(discordDmContext());
    expect(trustedGatewayContext).toBeTruthy();

    const modelOutput = {
      action: "attendance.check_in",
      messageId: "model-message",
      sender: { id: "model-user" },
      channelId: "model-channel",
      rawText: "model rewrite",
      trustedGatewayContext: {
        messageId: "model-context",
      },
    };
    const envelope = createTrustedGatewayActionEnvelope({
      modelOutput,
      trustedGatewayContext,
    });

    expect(envelope.trustedGatewayContext?.messageId).toBe("discord-message-1");
    expect(envelope.trustedGatewayContext?.sender.id).toBe("discord-user-1");
    expect(envelope.modelOutput.messageId).toBe("model-message");
    expect(envelope.modelOutput.trustedGatewayContext.messageId).toBe("model-context");
    expect(envelope.trustedGatewayContext).not.toBe(envelope.modelOutput.trustedGatewayContext);
  });

  it("defines a data-only boundary without attaching an attendance adapter", () => {
    const trustedGatewayContext = createTrustedGatewayContext(discordDmContext());
    const envelope = createTrustedGatewayActionEnvelope({
      modelOutput: { action: "attendance.check_in" },
      trustedGatewayContext,
    });

    expect(Object.keys(envelope).toSorted()).toEqual(["modelOutput", "trustedGatewayContext"]);
    expect("attendanceAgent" in envelope).toBe(false);
    expect("execute" in envelope).toBe(false);
  });
});
