import { describe, expect, it } from "vitest";
import {
  buildAgentToAgentMessageContext,
  buildAgentToAgentReplyContext,
} from "./sessions-send-helpers.js";

describe("sessions_send helper prompts", () => {
  it("does not include private-delivery guidance by default", () => {
    const prompt = buildAgentToAgentMessageContext({
      requesterSessionKey: "agent:main:main",
      requesterChannel: "main",
      targetSessionKey: "agent:target:discord:group:123",
    });

    expect(prompt).not.toContain('deliveryMode: "private"');
  });

  it("includes explicit private-delivery flags in sender reply guidance", () => {
    const prompt = buildAgentToAgentMessageContext({
      requesterSessionKey: "agent:main:main",
      requesterChannel: "main",
      targetSessionKey: "agent:target:discord:group:123",
      includePrivateReplyGuidance: true,
    });

    expect(prompt).toContain(
      'use sessions_send targeting agent:main:main with deliveryMode: "private"',
    );
    expect(prompt).toContain("announce: false for legacy clients");
  });

  it("shows sender-session continuation guidance only on target ping-pong turns", () => {
    const requesterTurnPrompt = buildAgentToAgentReplyContext({
      requesterSessionKey: "agent:main:main",
      requesterChannel: "main",
      targetSessionKey: "agent:target:discord:group:123",
      targetChannel: "discord",
      currentRole: "requester",
      turn: 1,
      maxTurns: 5,
      includePrivateReplyGuidance: true,
    });
    expect(requesterTurnPrompt).not.toContain('deliveryMode: "private"');

    const targetTurnPrompt = buildAgentToAgentReplyContext({
      requesterSessionKey: "agent:main:main",
      requesterChannel: "main",
      targetSessionKey: "agent:target:discord:group:123",
      targetChannel: "discord",
      currentRole: "target",
      turn: 2,
      maxTurns: 5,
      includePrivateReplyGuidance: true,
    });
    expect(targetTurnPrompt).toContain(
      'use sessions_send targeting agent:main:main with deliveryMode: "private"',
    );
  });
});
