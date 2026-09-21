import { describe, expect, it, vi } from "vitest";
import {
  isTrustedMessageActionTurnIngress,
  mintMessageActionTurnCapability,
  resolveMessageActionTurnAuthorization,
  resolveMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "./message-action-turn-capability.js";

describe("message action turn capability", () => {
  it("keeps dashboard permission private and rejects a retained grant after revocation", () => {
    const assertSourceCurrent = vi.fn();
    const identity = { agentId: "main", runId: "dashboard-run", sessionKey: "agent:main:main" };
    const token = mintMessageActionTurnCapability({
      ...identity,
      assertDashboardReadCurrent: assertSourceCurrent,
    });
    const lookup = { ...identity, token };
    const authorization = resolveMessageActionTurnAuthorization(lookup);
    const assertCurrent = authorization?.assertDashboardReadCurrent;
    expect(resolveMessageActionTurnCapability(lookup)).not.toHaveProperty(
      "assertDashboardReadCurrent",
    );
    expect(authorization?.toolContext).toBeUndefined();
    expect(authorization?.scheduled).toBeUndefined();
    expect(assertCurrent).toBeTypeOf("function");
    assertCurrent?.();
    expect(assertSourceCurrent).toHaveBeenCalledOnce();
    revokeMessageActionTurnCapability(token);
    expect(assertCurrent).toThrow("turn capability is no longer active");
    expect(assertSourceCurrent).toHaveBeenCalledOnce();
  });

  it("admits channel ingress but rejects Gateway and internal run sources", () => {
    expect(isTrustedMessageActionTurnIngress("whatsapp")).toBe(true);
    expect(isTrustedMessageActionTurnIngress("matrix")).toBe(true);
    expect(isTrustedMessageActionTurnIngress("webchat")).toBe(false);
    expect(isTrustedMessageActionTurnIngress("cron")).toBe(false);
    expect(isTrustedMessageActionTurnIngress(undefined)).toBe(false);
  });

  it("resolves only for the exact admitted run identity", () => {
    const token = mintMessageActionTurnCapability({
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:matrix:direct:room-1",
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
      nowMs: 1000,
      ttlMs: 5000,
    });

    expect(
      resolveMessageActionTurnCapability({
        token,
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:matrix:direct:room-1",
        sessionId: "session-1",
        nowMs: 2000,
      }),
    ).toMatchObject({
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
      expect(
        resolveMessageActionTurnCapability({
          token,
          agentId: mismatch.agentId ?? "main",
          runId: mismatch.runId ?? "run-1",
          sessionKey: mismatch.sessionKey ?? "agent:main:matrix:direct:room-1",
          sessionId: mismatch.sessionId ?? "session-1",
          nowMs: 2000,
        }),
      ).toBeUndefined();
    }
  });

  it("preserves reply-to-first state across capability resolutions", () => {
    const hasRepliedRef = { value: false };
    const token = mintMessageActionTurnCapability({
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:matrix:group:room",
      sessionId: "session-1",
      toolContext: {
        currentChannelProvider: "matrix",
        currentChannelId: "!room:example.org",
        replyToMode: "first",
        hasRepliedRef,
      },
    });

    const first = resolveMessageActionTurnCapability({
      token,
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:matrix:group:room",
      sessionId: "session-1",
    });
    expect(first?.toolContext?.hasRepliedRef).toBe(hasRepliedRef);
    first!.toolContext!.hasRepliedRef!.value = true;

    const second = resolveMessageActionTurnCapability({
      token,
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:matrix:group:room",
      sessionId: "session-1",
    });
    expect(second?.toolContext?.hasRepliedRef).toBe(hasRepliedRef);
    expect(second?.toolContext?.hasRepliedRef?.value).toBe(true);
  });

  it("expires and revokes capabilities fail closed", () => {
    const token = mintMessageActionTurnCapability({
      agentId: "main",
      runId: "run-1",
      sessionKey: "session-1",
      nowMs: 1000,
      ttlMs: 1000,
    });
    expect(
      resolveMessageActionTurnCapability({
        token,
        agentId: "main",
        runId: "run-1",
        sessionKey: "session-1",
        nowMs: 2000,
      }),
    ).toBeUndefined();

    const revoked = mintMessageActionTurnCapability({
      agentId: "main",
      runId: "run-2",
      sessionKey: "session-2",
    });
    expect(revokeMessageActionTurnCapability(revoked)).toBe(true);
    expect(
      resolveMessageActionTurnCapability({
        token: revoked,
        agentId: "main",
        runId: "run-2",
        sessionKey: "session-2",
      }),
    ).toBeUndefined();
  });
});
