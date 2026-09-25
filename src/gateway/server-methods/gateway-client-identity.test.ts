import { describe, expect, it } from "vitest";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import {
  gatewayClientSenderFields,
  gatewayClientSessionCreator,
  resolveChatSendCallerContext,
} from "./gateway-client-identity.js";
import type { GatewayClient } from "./types.js";

describe("gateway client identity", () => {
  it("sender provenance comes only from a live verified profile", () => {
    const profile = {
      profileId: "profile-id",
      displayName: "Person",
      hasAvatar: false,
      updatedAt: 1,
    };
    expect(
      gatewayClientSenderFields({ authenticatedUserId: "profile-id" } as GatewayClient),
    ).toEqual({ sender: { id: "profile-id" } });
    expect(
      gatewayClientSenderFields({ authenticatedUserProfile: profile } as GatewayClient),
    ).toEqual({
      sender: { id: "profile-id", name: "Person", identity: { type: "profile", id: "profile-id" } },
    });
    expect(
      gatewayClientSenderFields({
        authenticatedUserProfile: profile,
        internal: { syntheticClient: true },
      } as GatewayClient).sender,
    ).not.toHaveProperty("identity");
  });

  it("overrides sender attribution without replacing the authorizing identity", () => {
    const client = {
      authenticatedUserProfile: {
        profileId: "owner",
        displayName: "Owner",
        hasAvatar: false,
        updatedAt: 1,
      },
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
});

describe("chat send command authority", () => {
  function createClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
    return {
      authenticatedUserId: "ada@example.test",
      authenticatedUserProfile: {
        profileId: "profile-ada",
        displayName: "Ada",
        hasAvatar: false,
        updatedAt: 1,
      },
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        role: "operator",
        scopes: ["operator.write"],
      },
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

  it.each([
    { name: "verified human", overrides: {}, allowed: true },
    {
      name: "verified provider login",
      overrides: { authenticatedUserId: "ada@github", authenticatedUserIsTailscaleProvider: true },
      allowed: true,
    },
    {
      name: "fallback owner attribution",
      overrides: { authenticatedUserId: undefined },
      allowed: false,
    },
    {
      name: "unresolved profile",
      overrides: { authenticatedUserProfile: undefined },
      allowed: false,
    },
    {
      name: "synthetic caller",
      overrides: { internal: { syntheticClient: true as const } },
      allowed: false,
    },
    {
      name: "agent tool caller",
      overrides: {
        internal: { agentToolCaller: { agentId: "main", sessionKey: "agent:main:tool" } },
      },
      allowed: false,
    },
    { name: "revoked connection", overrides: { invalidated: true }, allowed: false },
  ])("matches human allowlists only for $name", ({ overrides, allowed }) => {
    const context = resolveChatSendCallerContext(createClient(overrides));
    expect(authorize(context)).toMatchObject({
      senderIsOwner: allowed,
      isAuthorizedSender: allowed,
    });
    expect(authorize(context, "profile-other")).toMatchObject({
      senderIsOwner: false,
      isAuthorizedSender: false,
    });
    expect(context).not.toHaveProperty("SenderId");
  });

  it.each([true, false])("preserves shipped CLI allowlists with profile=%s", (hasProfile) => {
    const client = createClient(hasProfile ? {} : { authenticatedUserProfile: undefined });
    client.connect.client = {
      id: "cli",
      version: "test",
      platform: "test",
      mode: "cli",
      displayName: "CLI",
    };
    const context = resolveChatSendCallerContext(client);
    expect(authorize(context, "cli")).toMatchObject({
      senderIsOwner: true,
      isAuthorizedSender: true,
    });
    expect(context).toMatchObject({ SenderId: "cli", SenderName: "CLI", SenderUsername: "CLI" });
    expect(authorize(resolveChatSendCallerContext(createClient()), "cli")).toMatchObject({
      senderIsOwner: false,
      isAuthorizedSender: false,
    });
  });

  it.each([
    {
      name: "invalidation",
      retire: (client: GatewayClient, _lifetime: AbortController) => {
        client.invalidated = true;
      },
    },
    {
      name: "closure",
      retire: (_client: GatewayClient, lifetime: AbortController) => {
        lifetime.abort();
      },
    },
    {
      name: "profile replacement",
      retire: (client: GatewayClient, _lifetime: AbortController) => {
        client.authenticatedUserProfile = {
          profileId: "profile-other",
          displayName: "Other",
          hasAvatar: false,
          updatedAt: 2,
        };
      },
    },
  ])("rechecks retained context after $name", ({ retire }) => {
    const lifetime = new AbortController();
    const client = createClient({ connectionSignal: lifetime.signal });
    const context = resolveChatSendCallerContext(client);
    expect(authorize(context).isAuthorizedSender).toBe(true);
    retire(client, lifetime);
    expect(authorize(context)).toMatchObject({ senderIsOwner: false, isAuthorizedSender: false });
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
