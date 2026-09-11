import { describe, expect, it } from "vitest";
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

describe("chat send caller identity", () => {
  it.each(["openclaw-control-ui", "cli"] as const)(
    "uses the verified profile instead of %s client metadata",
    (id) => {
      const client = {
        authenticatedUserProfile: { profileId: "profile-ada", updatedAt: 1 },
        connect: { client: { id, displayName: "Client label" } },
      } as GatewayClient;
      const context = resolveChatSendCallerContext(client);
      expect(context).toHaveProperty("SenderId", "profile-ada");
      expect(context).not.toHaveProperty("SenderName");
      expect(context).not.toHaveProperty("SenderUsername");
    },
  );

  it.each([true, false])("does not attribute synthetic callers with profile=%s", (hasProfile) => {
    const context = resolveChatSendCallerContext({
      internal: { syntheticClient: true },
      ...(hasProfile
        ? { authenticatedUserProfile: { profileId: "profile-ada", updatedAt: 1 } }
        : {}),
      connect: { client: { id: "cli", displayName: "Client label" } },
    } as GatewayClient);
    expect(context).not.toHaveProperty("SenderId");
    expect(context).not.toHaveProperty("SenderName");
    expect(context).not.toHaveProperty("SenderUsername");
  });

  it("preserves profileless client metadata without using unverified user aliases", () => {
    const client = {
      authenticatedUserId: "unverified-alias",
      connect: { client: { id: "cli", displayName: "CLI" } },
    } as GatewayClient;
    expect(resolveChatSendCallerContext(client)).toMatchObject({
      SenderId: "cli",
      SenderName: "CLI",
      SenderUsername: "CLI",
    });
    expect(
      resolveChatSendCallerContext({
        ...client,
        connect: { client: { id: "openclaw-control-ui", mode: "ui" } },
      } as GatewayClient),
    ).not.toHaveProperty("SenderId");
  });
});
