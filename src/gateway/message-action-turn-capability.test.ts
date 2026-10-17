import { describe, expect, it, vi } from "vitest";
import { createMessageToolTurnAuthority } from "../agents/tools/message-tool-turn-authority.js";
import {
  isTrustedMessageActionTurnIngress as isTrustedIngress,
  mintMessageActionTurnCapability as mintCapability,
  resolveMessageActionTurnAuthorization as resolveAuthorization,
  resolveMessageActionTurnCapability as resolveCapability,
  revokeMessageActionTurnCapability as revokeCapability,
} from "./message-action-turn-capability.js";

const identity = { agentId: "main", runId: "run-1", sessionKey: "session-1" };

describe("message action turn capability", () => {
  it("keeps a delivery-only restriction private without granting channel context", async () => {
    const assertCurrent = vi.fn();
    const beforeAttempt = vi.fn(async () => {
      revokeCapability(token);
    });
    const token = mintCapability({
      ...identity,
      deliveryAttempt: { beforeAttempt, assertCurrent },
    });
    const lookup = { ...identity, token };
    const authorization = resolveAuthorization(lookup);
    const restriction = authorization?.deliveryAttempt;
    try {
      expect(resolveCapability(lookup)).not.toHaveProperty("deliveryAttempt");
      expect([
        authorization?.scheduled,
        authorization?.toolContext,
        authorization?.requesterAccountId,
      ]).toEqual([undefined, undefined, undefined]);
      const authority = createMessageToolTurnAuthority({ ...lookup, getConfig: () => ({}) });
      expect(authority.beginInvocation("send").hasChannelTurnContext).toBe(false);
      expect(restriction).toBeDefined();
      await expect(restriction!.beforeAttempt()).rejects.toThrow(
        "turn capability is no longer active",
      );
      expect(beforeAttempt).toHaveBeenCalledOnce();
      expect(assertCurrent).toHaveBeenCalledOnce();
      expect(restriction!.assertCurrent).toThrow("turn capability is no longer active");
      expect(beforeAttempt).toHaveBeenCalledOnce();
    } finally {
      revokeCapability(token);
    }
  });

  it("keeps dashboard permission private and rejects a retained grant after revocation", () => {
    const assertSourceCurrent = vi.fn();
    const token = mintCapability({
      ...identity,
      assertDashboardReadCurrent: assertSourceCurrent,
    });
    const lookup = { ...identity, token };
    const authorization = resolveAuthorization(lookup);
    const assertCurrent = authorization?.assertDashboardReadCurrent;
    expect(resolveCapability(lookup)).not.toHaveProperty("assertDashboardReadCurrent");
    expect([authorization?.toolContext, authorization?.scheduled]).toEqual([undefined, undefined]);
    expect(assertCurrent).toBeTypeOf("function");
    assertCurrent?.();
    expect(assertSourceCurrent).toHaveBeenCalledOnce();
    revokeCapability(token);
    expect(assertCurrent).toThrow("turn capability is no longer active");
    expect(assertSourceCurrent).toHaveBeenCalledOnce();
  });

  it("admits channel ingress but rejects Gateway and internal run sources", () => {
    expect(["whatsapp", "matrix", "webchat", "cron", undefined].map(isTrustedIngress)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it("resolves only for the exact admitted run identity", () => {
    const admittedIdentity = {
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:matrix:direct:room-1",
      sessionId: "session-1",
    };
    const context = {
      sourceReplySessionKey: "agent:main:main",
      requesterAccountId: "ops",
      requesterSenderId: "@sender:example.org",
      requesterSenderName: "Sender Name",
      requesterSenderUsername: "sender-user",
      requesterSenderE164: "+15551234567",
      toolContext: {
        currentChannelProvider: "matrix",
        currentChannelId: "!room-1:example.org",
        currentChatType: "direct",
        currentSourceTurnId: "channel-user:v1:source-1",
      },
    } as const;
    const token = mintCapability({ ...admittedIdentity, ...context, nowMs: 1000, ttlMs: 5000 });
    const lookup = { ...admittedIdentity, token, nowMs: 2000 };
    expect(resolveCapability(lookup)).toMatchObject({
      ...context,
      sessionId: "session-1",
      expiresAtMs: 6000,
    });

    for (const mismatch of [
      { agentId: "other" },
      { runId: "run-2" },
      { sessionKey: "agent:main:matrix:direct:room-2" },
      { sessionId: "session-2" },
    ]) {
      expect(resolveCapability({ ...lookup, ...mismatch })).toBeUndefined();
    }
  });

  it("preserves reply-to-first state across capability resolutions", () => {
    const hasRepliedRef = { value: false };
    const token = mintCapability({
      ...identity,
      toolContext: {
        currentChannelProvider: "matrix",
        currentChannelId: "!room:example.org",
        replyToMode: "first",
        hasRepliedRef,
      },
    });

    const lookup = { ...identity, token };
    const first = resolveCapability(lookup);
    expect(first?.toolContext?.hasRepliedRef).toBe(hasRepliedRef);
    first!.toolContext!.hasRepliedRef!.value = true;

    const second = resolveCapability(lookup);
    expect(second?.toolContext?.hasRepliedRef).toBe(hasRepliedRef);
    expect(second?.toolContext?.hasRepliedRef?.value).toBe(true);
  });

  it("expires and revokes capabilities fail closed", () => {
    const token = mintCapability({ ...identity, nowMs: 1000, ttlMs: 1000 });
    expect(resolveCapability({ ...identity, token, nowMs: 2000 })).toBeUndefined();

    const nextIdentity = { ...identity, runId: "run-2", sessionKey: "session-2" };
    const revoked = mintCapability(nextIdentity);
    expect(revokeCapability(revoked)).toBe(true);
    expect(resolveCapability({ ...nextIdentity, token: revoked })).toBeUndefined();
  });
});
