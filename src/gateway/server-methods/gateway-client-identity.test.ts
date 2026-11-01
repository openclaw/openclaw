import { describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import { createRemoteControlUiIngressTestContext } from "../remote-control-ui.test-support.js";
import { prepareTurn } from "./chat-send-user-turn-family.test-support.js";
import { createClientInfo } from "./chat-send-user-turn.test-support.js";
import {
  authenticatedProfileUnavailableError,
  gatewayClientSenderFields,
  gatewayClientSessionCreator,
  resolveChatSendCallerContext,
} from "./gateway-client-identity.js";
import { createSessionMutationTestClient } from "./sessions-mutations.owner.test-support.js";
import type { GatewayClient } from "./types.js";

function profile(profileId: string, displayName: string, updatedAt = 1) {
  return { profileId, displayName, hasAvatar: false, updatedAt };
}

describe("gateway client identity", () => {
  it("sender provenance comes only from a live verified profile", () => {
    const person = profile("profile-id", "Person");
    expect(
      gatewayClientSenderFields({ authenticatedUserId: "profile-id" } as GatewayClient),
    ).toEqual({ sender: { id: "profile-id" } });
    expect(
      gatewayClientSenderFields({ authenticatedUserProfile: person } as GatewayClient),
    ).toEqual({
      sender: { id: "profile-id", name: "Person", identity: { type: "profile", id: "profile-id" } },
    });
    expect(
      gatewayClientSenderFields({
        authenticatedUserProfile: person,
        internal: { syntheticClient: true },
      } as GatewayClient).sender,
    ).not.toHaveProperty("identity");
  });

  it("overrides sender attribution without replacing the authorizing identity", () => {
    const client = {
      authenticatedUserProfile: profile("owner", "Owner"),
      internal: {
        syntheticClient: true,
        senderAttribution: {
          id: "alice",
          name: "Suggested by Alice",
          identity: { type: "profile", id: "alice" },
        },
      },
    } as GatewayClient;

    expect(gatewayClientSessionCreator(client)).toEqual({
      type: "human",
      id: "owner",
      label: "Owner",
    });
    expect(gatewayClientSenderFields(client)).toEqual({
      sender: {
        id: "alice",
        name: "Suggested by Alice",
        identity: { type: "profile", id: "alice" },
      },
    });
  });

  it("keeps a GitHub-backed mutable alias unattributed until immutable sync completes", () => {
    const client = {
      authenticatedUserId: "released-login@github",
      authenticatedGitHubIdentitySync: async () => ({ profileId: "owner", updatedAt: 1 }),
    } as GatewayClient;

    expect(gatewayClientSenderFields(client)).toEqual({});
    expect(gatewayClientSessionCreator(client)).toBeUndefined();
  });

  it("reports unavailable profiles without loading the GitHub plugin surface", () => {
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    for (const cause of [undefined, new Error("profile store unavailable")]) {
      expect(authenticatedProfileUnavailableError(cause)).toMatchObject({
        code: "UNAVAILABLE",
        message: expect.stringContaining("Authenticated profile verification is unavailable"),
        retryAfterMs: 1_000,
      });
    }
  });
});

describe("chat send command authority", () => {
  function createClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
    return {
      ...createSessionMutationTestClient(),
      authenticatedUserId: "ada@example.test",
      authenticatedUserProfile: profile("profile-ada", "Ada"),
      ...overrides,
    };
  }
  function authorize(
    context: ReturnType<typeof resolveChatSendCallerContext>,
    entry = "profile-ada",
  ) {
    return resolveCommandAuthorization({
      ctx: { ...context },
      cfg: { commands: { ownerAllowFrom: [entry], allowFrom: { "*": [entry] } } },
      commandAuthorized: true,
    });
  }

  function expectAuthority(
    context: ReturnType<typeof resolveChatSendCallerContext>,
    allowed: boolean,
    entry?: string,
  ) {
    expect(authorize(context, entry)).toMatchObject({
      senderIsOwner: allowed,
      isAuthorizedSender: allowed,
    });
  }

  it.each<[string, Partial<GatewayClient>, boolean]>([
    ["verified human", {}, true],
    ["fallback owner attribution", { authenticatedUserId: undefined }, false],
    ["unresolved profile", { authenticatedUserProfile: undefined }, false],
    ["synthetic caller", { internal: { syntheticClient: true } }, false],
    [
      "agent tool caller",
      {
        internal: { agentToolCaller: { agentId: "main", sessionKey: "agent:main:tool" } },
      },
      false,
    ],
  ])("matches human allowlists only for %s", (_name, overrides, allowed) => {
    const context = resolveChatSendCallerContext(createClient(overrides));
    expectAuthority(context, allowed);
    expectAuthority(context, false, "profile-other");
    expect(context).not.toHaveProperty("SenderId");
  });

  it.each(["revoked", "aborted", "rebound", "synthetic"] as const)(
    "uses live person ingress command authority without a proxy login and rejects %s authority",
    (change) => {
      const lifetime = new AbortController();
      let current = true;
      const client = createClient({ authenticatedUserId: undefined });
      const principal = createRemoteControlUiIngressTestContext({
        audienceId: "synthetic-command-grant",
        principal: { kind: "person", profileId: "profile-ada" },
        operatorScopeCeiling: ["operator.write"],
        signal: lifetime.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("Grant revoked");
          }
        },
      }).resolvePrincipal();
      const internal: NonNullable<GatewayClient["internal"]> = {
        operatorRoleActor: principal.operatorRoleActor,
        remoteIngressPrincipal: principal,
      };
      client.internal = internal;
      const context = resolveChatSendCallerContext(client);
      expect(authorize(context).isAuthorizedSender).toBe(true);
      expect(authorize(context, "profile-other").isAuthorizedSender).toBe(false);
      if (change === "revoked") {
        current = false;
      } else if (change === "aborted") {
        lifetime.abort();
      } else if (change === "rebound") {
        client.authenticatedUserProfile!.profileId = "profile-other";
      } else {
        internal.syntheticClient = true;
      }
      expect(authorize(context).isAuthorizedSender).toBe(false);
    },
  );

  it("preserves shipped CLI allowlists without a profile", () => {
    const client = createClient({ authenticatedUserProfile: undefined });
    client.connect.client = createClientInfo({ displayName: "CLI" });
    const context = resolveChatSendCallerContext(client);
    expectAuthority(context, true, "cli");
    expect(context).toMatchObject({ SenderId: "cli", SenderName: "CLI", SenderUsername: "CLI" });
    expectAuthority(resolveChatSendCallerContext(createClient()), false, "cli");
  });

  it.each([
    "profile",
    "profile-replacement",
    "identity",
    "disconnect",
    "invalidated",
    "admission",
    "synthetic",
    "owner",
  ] as const)("retires verified requester context after %s changes", (change) => {
    const lifetime = new AbortController();
    const client = createClient({
      authenticatedUserId: change === "owner" ? undefined : "ada@example.test",
      internal: change === "owner" ? { authenticatedOperator: true } : undefined,
      connectionSignal: lifetime.signal,
    });
    const commandContext = resolveChatSendCallerContext(client);
    expectAuthority(commandContext, change !== "owner");
    let current = true;
    const { ctx } = prepareTurn({
      inputText: "Change my theme",
      request: { inboundMessage: "Change my theme", clientInfo: client.connect.client },
      session: { clientRunId: "owner-turn" },
      admission: {
        originatingRoute: {
          originatingChannel: "webchat",
          accountId: "account-1",
          explicitDeliverRoute: false,
        },
        assertWorkAdmissionCurrent: () => {
          if (!current) {
            throw new Error("Admission retired");
          }
        },
      },
      attachments: { parsedMessage: "Change my theme" },
      client,
    });
    const render = () => buildInboundUserContextPrefix(finalizeInboundContext({ ...ctx }));
    expect(render()).toContain("requester_profile");
    expect(render()).toContain("profile-ada");
    switch (change) {
      case "profile":
        client.authenticatedUserProfile!.profileId = "profile-bob";
        break;
      case "profile-replacement":
        client.authenticatedUserProfile = profile("profile-other", "Other", 2);
        break;
      case "identity":
        client.authenticatedUserId = "bob@example.test";
        break;
      case "disconnect":
        lifetime.abort();
        break;
      case "invalidated":
        client.invalidated = true;
        break;
      case "admission":
        current = false;
        break;
      case "synthetic":
        client.internal = { syntheticClient: true };
        break;
      case "owner":
        client.internal = {};
        break;
    }
    expect(render()).not.toContain("requester_profile");
    expect(ctx).not.toHaveProperty("SenderId");
    if (change !== "admission" && change !== "identity") {
      expectAuthority(commandContext, false);
    }
  });

  it("does not inherit human or application candidates from ambient agent work", async () => {
    const client = createClient();
    client.connect.client.id = "cli";
    await withGatewayToolCallerIdentity({ agentId: "main", sessionKey: "agent:main:tool" }, () => {
      const context = resolveChatSendCallerContext(client);
      expect(authorize(context).isAuthorizedSender).toBe(false);
      expect(authorize(context, "cli").isAuthorizedSender).toBe(false);
    });
  });
});
