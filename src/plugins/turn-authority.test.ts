import { describe, expect, it } from "vitest";
import { createAuthorizationPrincipal } from "./authorization-policy-context.js";
import {
  classifyTurnAuthoritySnapshot,
  createTurnAuthoritySnapshot,
  rebindTurnAuthoritySnapshot,
  resolveTurnAuthorityAuthorization,
  restoreVerifiedTurnAuthoritySnapshot,
} from "./turn-authority.js";

describe("turn authority sender aliases", () => {
  it("normalizes, freezes, and preserves aliases while rebinding", () => {
    const source = createTurnAuthoritySnapshot({
      principal: createAuthorizationPrincipal({
        provider: "discord",
        accountId: "molty",
        senderId: "maintainer-1",
        senderName: "  Ada Lovelace  ",
        senderUsername: " @Ada ",
        senderE164: " +15550001111 ",
      }),
      agentId: "molty",
      sessionKey: "agent:molty:discord:channel:maintenance",
      trigger: "channel",
    });

    expect(source.authorization.principal).toMatchObject({
      kind: "sender",
      aliases: {
        name: "ada lovelace",
        username: "ada",
        e164: "+15550001111",
      },
    });
    if (source.authorization.principal.kind !== "sender") {
      throw new Error("expected sender principal");
    }
    expect(Object.isFrozen(source.authorization.principal.aliases)).toBe(true);

    const rebound = rebindTurnAuthoritySnapshot(source, {
      agentId: "molty",
      sessionKey: "agent:molty:main",
      sessionId: "session-2",
      trigger: "queue",
    });

    expect(rebound?.authorization.principal).toEqual(source.authorization.principal);
    expect(rebound?.authorization.principal).not.toBe(source.authorization.principal);
    if (rebound?.authorization.principal.kind !== "sender") {
      throw new Error("expected rebound sender principal");
    }
    expect(Object.isFrozen(rebound.authorization.principal.aliases)).toBe(true);
  });

  it("strictly restores normalized aliases from a verified envelope", () => {
    const restored = restoreVerifiedTurnAuthoritySnapshot({
      authorization: {
        principal: {
          kind: "sender",
          provider: "discord",
          senderId: "maintainer-1",
          aliases: {
            name: "  Ada Lovelace ",
            username: " @Ada ",
            e164: " +15550001111 ",
          },
        },
        agentId: "molty",
        sessionKey: "agent:molty:main",
      },
    });

    expect(restored?.authorization.principal).toMatchObject({
      kind: "sender",
      aliases: {
        name: "ada lovelace",
        username: "ada",
        e164: "+15550001111",
      },
    });
    expect(
      restoreVerifiedTurnAuthoritySnapshot({
        authorization: {
          principal: {
            kind: "sender",
            senderId: "maintainer-1",
            aliases: { username: 42 },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("distinguishes absent authority from supplied unissued values", () => {
    const source = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer-1" },
      agentId: "molty",
      sessionKey: "agent:molty:main",
    });
    const rebindParams = {
      agentId: "molty",
      sessionKey: "agent:molty:main",
      trigger: "queue",
    };

    expect(resolveTurnAuthorityAuthorization(undefined)).toBeUndefined();
    expect(rebindTurnAuthoritySnapshot(undefined, rebindParams)).toBeUndefined();
    expect(resolveTurnAuthorityAuthorization(source)).toBe(source.authorization);
    expect(classifyTurnAuthoritySnapshot(undefined)).toEqual({ kind: "absent" });
    expect(classifyTurnAuthoritySnapshot(source)).toEqual({ kind: "issued", snapshot: source });

    for (const invalid of [structuredClone(source), {}, null]) {
      expect(classifyTurnAuthoritySnapshot(invalid)).toEqual({ kind: "invalid" });
      expect(() => resolveTurnAuthorityAuthorization(invalid)).toThrowError(
        "turn-authority-invalid",
      );
      expect(() => rebindTurnAuthoritySnapshot(invalid, rebindParams)).toThrowError(
        "turn-authority-invalid",
      );
    }
  });
});
