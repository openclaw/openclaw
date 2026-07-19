import { describe, expect, it } from "vitest";
import { createAuthorizationPrincipal } from "../../plugins/authorization-policy-context.js";
import {
  createOperatorTurnAuthoritySnapshot,
  createTurnAuthoritySnapshot,
} from "../../plugins/turn-authority.js";
import {
  createSteeringAuthorizationAffinity,
  steeringAuthorizationAffinitiesMatch,
  type SteeringAuthorizationAffinity,
} from "./steering-authorization-affinity.js";

const baseAuthorityInput = {
  principal: createAuthorizationPrincipal({
    provider: "Discord",
    accountId: "molty",
    senderId: "maintainer",
    senderIsOwner: false,
    isAuthorizedSender: true,
    roleIds: ["writers", "maintainers", "writers"],
  }),
  agentId: "molty",
  sessionKey: "agent:molty:discord:channel:maintenance",
  conversationId: "thread-1",
  parentConversationId: "maintenance",
  threadId: "thread-1",
  controllerKey: "sender:discord:molty:maintainer",
} as const;

function createSenderAuthority(
  overrides: Partial<Parameters<typeof createTurnAuthoritySnapshot>[0]> = {},
) {
  return createTurnAuthoritySnapshot({ ...baseAuthorityInput, ...overrides });
}

function createSenderAffinity(
  overrides: Partial<Parameters<typeof createTurnAuthoritySnapshot>[0]> = {},
) {
  return createSteeringAuthorizationAffinity({
    turnAuthority: createSenderAuthority(overrides),
  });
}

describe("steering authorization affinity", () => {
  it("rejects unknown snapshots and operators without an authenticated controller", () => {
    const unknown = createSteeringAuthorizationAffinity({
      turnAuthority: createTurnAuthoritySnapshot({
        principal: createAuthorizationPrincipal({}),
        agentId: "main",
        sessionKey: "agent:main:main",
        conversationId: "agent:main:main",
      }),
    });
    const controllerlessOperator = createSteeringAuthorizationAffinity({
      turnAuthority: createTurnAuthoritySnapshot({
        principal: createAuthorizationPrincipal({ operatorScopes: ["operator.write"] }),
        agentId: "main",
        sessionKey: "agent:main:main",
        conversationId: "agent:main:main",
      }),
    });

    expect(unknown).toEqual({ incomplete: true });
    expect(controllerlessOperator).toEqual({ incomplete: true });
    expect(steeringAuthorizationAffinitiesMatch(unknown, unknown)).toBe(false);
  });

  it.each(["agentId", "sessionKey", "conversationId"] as const)(
    "rejects issued sender authority without %s target scope",
    (missing) => {
      const scope: {
        agentId?: string;
        sessionKey?: string;
        conversationId?: string;
      } = {
        agentId: "main",
        sessionKey: "agent:main:discord:channel:maintenance",
        conversationId: "maintenance",
      };
      delete scope[missing];
      const affinity = createSteeringAuthorizationAffinity({
        turnAuthority: createTurnAuthoritySnapshot({
          principal: createAuthorizationPrincipal({
            provider: "discord",
            senderId: "maintainer",
            isAuthorizedSender: true,
          }),
          ...scope,
        }),
      });

      expect(affinity).toEqual({ incomplete: true });
      expect(steeringAuthorizationAffinitiesMatch(affinity, affinity)).toBe(false);
    },
  );

  it("matches equivalent host-issued authority snapshots", () => {
    const expected = createSenderAffinity();
    const incoming = createSenderAffinity();

    expect(expected).toEqual({
      kind: "authority",
      authority: expect.objectContaining({
        authorization: expect.objectContaining({
          principal: {
            kind: "sender",
            provider: "Discord",
            accountId: "molty",
            senderId: "maintainer",
            senderIsOwner: false,
            isAuthorizedSender: true,
            roleIds: ["maintainers", "writers"],
          },
          agentId: "molty",
          sessionKey: "agent:molty:discord:channel:maintenance",
          conversationId: "thread-1",
          parentConversationId: "maintenance",
          threadId: "thread-1",
        }),
      }),
    });
    expect(Object.isFrozen(expected)).toBe(true);
    expect(steeringAuthorizationAffinitiesMatch(expected, incoming)).toBe(true);
  });

  it.each([
    ["sender", { senderId: "other-maintainer" }],
    ["owner bit", { senderIsOwner: true }],
    ["authorization bit", { isAuthorizedSender: false }],
    ["roles", { roleIds: ["maintainers"] }],
    ["account", { accountId: "other" }],
    ["provider", { provider: "slack" }],
  ] as const)("rejects changed %s principal authority", (_label, principalOverride) => {
    const expected = createSenderAffinity();
    const incoming = createSenderAffinity({
      principal: createAuthorizationPrincipal({
        provider: "Discord",
        accountId: "molty",
        senderId: "maintainer",
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["writers", "maintainers"],
        ...principalOverride,
      }),
    });

    expect(steeringAuthorizationAffinitiesMatch(expected, incoming)).toBe(false);
  });

  it.each([
    ["agent", { agentId: "clawsweeper" }],
    ["session", { sessionKey: "agent:molty:discord:channel:other" }],
    ["conversation", { conversationId: "thread-2" }],
    ["parent", { parentConversationId: "other-parent" }],
    ["thread", { threadId: "thread-2" }],
  ] as const)("rejects changed %s target authority", (_label, override) => {
    expect(
      steeringAuthorizationAffinitiesMatch(createSenderAffinity(), createSenderAffinity(override)),
    ).toBe(false);
  });

  it("does not issue control authority from raw legacy sender or controller assertions", () => {
    const createFromLegacy = createSteeringAuthorizationAffinity as (
      params: Record<string, unknown>,
    ) => SteeringAuthorizationAffinity;
    const rawSender = createFromLegacy({
      provider: "discord",
      accountId: "molty",
      senderId: "maintainer",
      senderIsOwner: true,
      isAuthorizedSender: true,
      roleIds: ["maintainers"],
      agentId: "molty",
      sessionKey: "agent:molty:discord:channel:maintenance",
      conversationId: "maintenance",
    });
    const rawController = createFromLegacy({
      trustedControllerId: "local",
      agentId: "main",
      sessionKey: "agent:main:main",
    });

    expect(rawSender).toEqual({ incomplete: true });
    expect(rawController).toEqual({ incomplete: true });
    expect(steeringAuthorizationAffinitiesMatch(rawSender, rawSender)).toBe(false);
    expect(steeringAuthorizationAffinitiesMatch(rawController, rawController)).toBe(false);
  });

  it("issues exact authenticated operator authority", () => {
    const expected = createSteeringAuthorizationAffinity({
      turnAuthority: createOperatorTurnAuthoritySnapshot({
        scopes: ["operator.write"],
        connectionId: "local",
        agentId: "main",
        sessionKey: "agent:main:main",
        conversationId: "agent:main:main",
      }),
    });
    const incoming = createSteeringAuthorizationAffinity({
      turnAuthority: createOperatorTurnAuthoritySnapshot({
        scopes: ["operator.write"],
        connectionId: "local",
        agentId: "main",
        sessionKey: "agent:main:main",
        conversationId: "agent:main:main",
      }),
    });

    expect(steeringAuthorizationAffinitiesMatch(expected, incoming)).toBe(true);
    expect(
      steeringAuthorizationAffinitiesMatch(
        expected,
        createSteeringAuthorizationAffinity({
          turnAuthority: createOperatorTurnAuthoritySnapshot({
            scopes: ["operator.write"],
            connectionId: "other",
            agentId: "main",
            sessionKey: "agent:main:main",
            conversationId: "agent:main:main",
          }),
        }),
      ),
    ).toBe(false);
  });

  it("rejects missing and forged queue provenance", () => {
    const issued = createSenderAffinity();
    const forged = structuredClone(issued) as SteeringAuthorizationAffinity;

    expect(steeringAuthorizationAffinitiesMatch(undefined, undefined)).toBe(false);
    expect(steeringAuthorizationAffinitiesMatch(issued, forged)).toBe(false);
  });
});
