import { describe, expect, it, vi } from "vitest";
import { createMessageToolTurnAuthority } from "../agents/tools/message-tool-turn-authority.js";
import {
  isTrustedMessageActionTurnIngress as isTrustedIngress,
  mintMessageActionTurnCapability as mintCapability,
  resolveMessageActionTurnAuthorization as resolveAuthorization,
  resolveMessageActionTurnCapability as resolveCapability,
  revokeMessageActionTurnCapability as revokeCapability,
} from "./message-action-turn-capability.js";

describe("message action turn capability", () => {
  it("keeps a delivery-only restriction private without granting channel context", async () => {
    const identity = {
      agentId: "main",
      runId: "legacy-cron",
      sessionKey: "agent:main:cron:legacy",
    };
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
      expect(authorization?.scheduled).toBeUndefined();
      expect(authorization?.toolContext).toBeUndefined();
      expect(authorization?.requesterAccountId).toBeUndefined();
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
    const identity = { agentId: "main", runId: "dashboard-run", sessionKey: "agent:main:main" };
    const token = mintCapability({
      ...identity,
      assertDashboardReadCurrent: assertSourceCurrent,
    });
    const lookup = { ...identity, token };
    const authorization = resolveAuthorization(lookup);
    const assertCurrent = authorization?.assertDashboardReadCurrent;
    expect(resolveCapability(lookup)).not.toHaveProperty("assertDashboardReadCurrent");
    expect(authorization?.toolContext).toBeUndefined();
    expect(authorization?.scheduled).toBeUndefined();
    expect(assertCurrent).toBeTypeOf("function");
    assertCurrent?.();
    expect(assertSourceCurrent).toHaveBeenCalledOnce();
    revokeCapability(token);
    expect(assertCurrent).toThrow("turn capability is no longer active");
    expect(assertSourceCurrent).toHaveBeenCalledOnce();
  });

  it("admits channel ingress but rejects Gateway and internal run sources", () => {
    expect(isTrustedIngress("whatsapp")).toBe(true);
    expect(isTrustedIngress("matrix")).toBe(true);
    expect(isTrustedIngress("webchat")).toBe(false);
    expect(isTrustedIngress("cron")).toBe(false);
    expect(isTrustedIngress(undefined)).toBe(false);
  });

  it("resolves only for the exact admitted run identity", () => {
    const identity = {
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:matrix:direct:room-1",
      sessionId: "session-1",
    };
    const token = mintCapability({
      ...identity,
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
      nowMs: 1000,
      ttlMs: 5000,
    });

    const lookup = { ...identity, token, nowMs: 2000 };
    expect(resolveCapability(lookup)).toMatchObject({
      expiresAtMs: 6000,
      sourceReplySessionKey: "agent:main:main",
      sessionId: "session-1",
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
    const identity = {
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:matrix:group:room",
      sessionId: "session-1",
    };
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
    const identity = { agentId: "main", runId: "run-1", sessionKey: "session-1" };
    const token = mintCapability({
      ...identity,
      nowMs: 1000,
      ttlMs: 1000,
    });
    expect(
      resolveCapability({
        ...identity,
        token,
        nowMs: 2000,
      }),
    ).toBeUndefined();

    const nextIdentity = { ...identity, runId: "run-2", sessionKey: "session-2" };
    const revoked = mintCapability(nextIdentity);
    expect(revokeCapability(revoked)).toBe(true);
    expect(resolveCapability({ ...nextIdentity, token: revoked })).toBeUndefined();
  });
});
