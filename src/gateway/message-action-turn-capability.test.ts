import { describe, expect, it } from "vitest";
import type { TurnAuthoritySnapshot } from "../plugins/authorization-policy.types.js";
import { createTurnAuthoritySnapshot } from "../plugins/turn-authority.js";
import {
  isTrustedMessageActionTurnIngress,
  mintMessageActionTurnCapability,
  resolveMessageActionTurnCapability,
  resolveMessageActionTurnCapabilityLifetime,
  revokeMessageActionTurnCapability,
} from "./message-action-turn-capability.js";

describe("message action turn capability", () => {
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
      sessionId: "session-1",
      requesterAccountId: "ops",
      requesterSenderId: "@sender:example.org",
      requesterSenderIsOwner: false,
      requesterIsAuthorizedSender: true,
      requesterRoleIds: ["maintainers", "contributors", "maintainers"],
      parentConversationId: "!parent:example.org",
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
      sessionId: "session-1",
      requesterAccountId: "ops",
      requesterSenderId: "@sender:example.org",
      requesterSenderIsOwner: false,
      requesterIsAuthorizedSender: true,
      requesterRoleIds: ["contributors", "maintainers"],
      parentConversationId: "!parent:example.org",
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

  it("keeps legitimate turns longer than the TTL cap alive until revocation", () => {
    const lifetime = resolveMessageActionTurnCapabilityLifetime(48 * 60 * 60_000);
    expect(lifetime).toEqual({ expiresWithRun: true });
    const token = mintMessageActionTurnCapability({
      agentId: "main",
      runId: "run-long",
      sessionKey: "session-long",
      nowMs: 1000,
      ...lifetime,
    });

    expect(
      resolveMessageActionTurnCapability({
        token,
        agentId: "main",
        runId: "run-long",
        sessionKey: "session-long",
        nowMs: 48 * 60 * 60_000,
      }),
    ).toBeDefined();
    expect(revokeMessageActionTurnCapability(token)).toBe(true);
  });

  it("requires session identity to match in both directions", () => {
    const identity = {
      agentId: "main",
      runId: "run-session-bound",
      sessionKey: "agent:main:matrix:direct:room-session-bound",
    } as const;
    const withoutSession = mintMessageActionTurnCapability(identity);
    const withSession = mintMessageActionTurnCapability({
      ...identity,
      sessionId: "session-bound",
    });

    try {
      expect(
        resolveMessageActionTurnCapability({
          token: withoutSession,
          ...identity,
        }),
      ).toBeDefined();
      expect(
        resolveMessageActionTurnCapability({
          token: withoutSession,
          ...identity,
          sessionId: "injected-session",
        }),
      ).toBeUndefined();

      expect(
        resolveMessageActionTurnCapability({
          token: withSession,
          ...identity,
          sessionId: "session-bound",
        }),
      ).toBeDefined();
      for (const sessionId of [undefined, "different-session"]) {
        expect(
          resolveMessageActionTurnCapability({
            token: withSession,
            ...identity,
            sessionId,
          }),
        ).toBeUndefined();
      }
    } finally {
      revokeMessageActionTurnCapability(withoutSession);
      revokeMessageActionTurnCapability(withSession);
    }
  });

  it("requires supplied turn authority to be host-issued and execution-bound", () => {
    const identity = {
      agentId: "main",
      runId: "run-bound",
      sessionKey: "agent:main:matrix:direct:room-bound",
      sessionId: "session-bound",
    } as const;
    const authority = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        provider: "matrix",
        senderId: "@maintainer:example.org",
        isAuthorizedSender: true,
      },
      ...identity,
      conversationId: "!room-bound:example.org",
      trigger: "message",
    });
    const capability = mintMessageActionTurnCapability({
      ...identity,
      turnAuthority: authority,
    });
    expect(
      resolveMessageActionTurnCapability({
        token: capability,
        ...identity,
      })?.turnAuthority,
    ).toBe(authority);

    expect(() =>
      mintMessageActionTurnCapability({
        ...identity,
        turnAuthority: { ...authority } as TurnAuthoritySnapshot,
      }),
    ).toThrow("requires host-issued turn authority");

    for (const mismatch of [
      { agentId: "other" },
      { runId: "run-other" },
      { sessionKey: "agent:main:matrix:direct:room-other" },
      { sessionId: "session-other" },
    ]) {
      expect(() =>
        mintMessageActionTurnCapability({
          agentId: mismatch.agentId ?? identity.agentId,
          runId: mismatch.runId ?? identity.runId,
          sessionKey: mismatch.sessionKey ?? identity.sessionKey,
          sessionId: mismatch.sessionId ?? identity.sessionId,
          turnAuthority: authority,
        }),
      ).toThrow("does not match execution identity");
    }
  });

  it("projects requester identity from issued sender authority", () => {
    const identity = {
      agentId: "main",
      runId: "run-canonical-sender",
      sessionKey: "agent:main:matrix:direct:canonical-sender",
      sessionId: "session-canonical-sender",
    } as const;
    const authority = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        provider: "matrix",
        accountId: "trusted-account",
        senderId: "@trusted:example.org",
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["maintainers", "write"],
      },
      ...identity,
      trigger: "message",
    });
    const token = mintMessageActionTurnCapability({
      ...identity,
      requesterAccountId: "legacy-account",
      requesterSenderId: "@legacy:example.org",
      requesterSenderIsOwner: true,
      requesterIsAuthorizedSender: false,
      requesterRoleIds: ["legacy-admin"],
      turnAuthority: authority,
    });

    try {
      expect(resolveMessageActionTurnCapability({ token, ...identity })).toMatchObject({
        requesterAccountId: "trusted-account",
        requesterSenderId: "@trusted:example.org",
        requesterSenderIsOwner: false,
        requesterIsAuthorizedSender: true,
        requesterRoleIds: ["maintainers", "write"],
        turnAuthority: authority,
      });
    } finally {
      revokeMessageActionTurnCapability(token);
    }
  });

  it.each([
    {
      name: "operator",
      principal: { kind: "operator", scopes: ["operator.write"], isOwner: false } as const,
      expected: { requesterSenderIsOwner: false },
    },
    {
      name: "service",
      principal: { kind: "service", serviceId: "scheduled-job" } as const,
      expected: { requesterSenderIsOwner: false },
    },
    {
      name: "unknown",
      principal: { kind: "unknown", accountId: "trusted-account" } as const,
      expected: { requesterAccountId: "trusted-account", requesterSenderIsOwner: false },
    },
  ])("clears legacy sender facts for issued $name authority", ({ name, principal, expected }) => {
    const identity = {
      agentId: "main",
      runId: `run-canonical-${name}`,
      sessionKey: `agent:main:matrix:direct:canonical-${name}`,
      sessionId: `session-canonical-${name}`,
    };
    const authority = createTurnAuthoritySnapshot({
      principal,
      ...identity,
      trigger: "message",
    });
    const token = mintMessageActionTurnCapability({
      ...identity,
      requesterAccountId: "legacy-account",
      requesterSenderId: "@legacy:example.org",
      requesterSenderIsOwner: true,
      requesterIsAuthorizedSender: true,
      requesterRoleIds: ["legacy-admin"],
      turnAuthority: authority,
    });

    try {
      const resolved = resolveMessageActionTurnCapability({ token, ...identity });
      expect(resolved).toMatchObject(expected);
      expect(resolved?.requesterSenderId).toBeUndefined();
      expect(resolved?.requesterIsAuthorizedSender).toBeUndefined();
      expect(resolved?.requesterRoleIds).toBeUndefined();
      if (name !== "unknown") {
        expect(resolved?.requesterAccountId).toBeUndefined();
      }
    } finally {
      revokeMessageActionTurnCapability(token);
    }
  });

  it("does not evict live capabilities when a full-store mint has invalid authority", () => {
    const identity = {
      agentId: "main",
      runId: "run-capacity",
      sessionKey: "agent:main:matrix:direct:room-capacity",
      sessionId: "session-capacity",
    } as const;
    const resolve = (token: string) => resolveMessageActionTurnCapability({ token, ...identity });
    const sentinel = mintMessageActionTurnCapability({
      ...identity,
      expiresWithRun: true,
    });
    const liveTokens: string[] = [];

    try {
      // Detect the actual store limit by filling until this newest sentinel is
      // evicted. Every token minted after it is then one complete live store.
      while (resolve(sentinel)) {
        if (liveTokens.length >= 10_000) {
          throw new Error("message action capability store did not reach capacity");
        }
        liveTokens.push(
          mintMessageActionTurnCapability({
            ...identity,
            expiresWithRun: true,
          }),
        );
      }
      expect(liveTokens.length).toBeGreaterThan(0);

      const authority = createTurnAuthoritySnapshot({
        principal: { kind: "service", serviceId: "capacity-test" },
        ...identity,
        trigger: "message",
      });
      expect(() =>
        mintMessageActionTurnCapability({
          ...identity,
          expiresWithRun: true,
          turnAuthority: { ...authority } as TurnAuthoritySnapshot,
        }),
      ).toThrow("requires host-issued turn authority");

      for (const token of liveTokens) {
        expect(resolve(token)).toBeDefined();
      }
    } finally {
      revokeMessageActionTurnCapability(sentinel);
      for (const token of liveTokens) {
        revokeMessageActionTurnCapability(token);
      }
    }
  });
});
