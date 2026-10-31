import { describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import { resolveElevatedPermissions } from "../../auto-reply/reply/reply-elevated.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { createRemoteControlUiIngressTestContext } from "../remote-control-ui.test-support.js";
import { gatewayProfile as profile } from "../server/client-fixtures.test-support.js";
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

function createClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    ...createSessionMutationTestClient("profile-ada"),
    authenticatedUserProfile: profile("profile-ada", "Ada"),
    ...overrides,
  };
}

function elevated(ctx: MsgContext, global = ["profile-ada"], agent = global) {
  const policy = (entries: string[]) => ({ enabled: true, allowFrom: { webchat: entries } });
  return resolveElevatedPermissions({
    cfg: {
      tools: { elevated: policy(global) },
      agents: { entries: { main: { tools: { elevated: policy(agent) } } } },
    },
    agentId: "main",
    ctx,
    provider: ctx.Provider ?? "",
  });
}

const elevatedAllowed = { enabled: true, allowed: true, failures: [] };
const elevatedDenied = (key = "tools.elevated.allowFrom.webchat") => ({
  enabled: true,
  allowed: false,
  failures: [{ gate: "allowFrom", key }],
});

function expectAuthority(context: MsgContext, allowed: boolean, entry = "profile-ada") {
  expect(
    resolveCommandAuthorization({
      ctx: { ...context },
      cfg: { commands: { ownerAllowFrom: [entry], allowFrom: { "*": [entry] } } },
      commandAuthorized: true,
    }),
  ).toMatchObject({
    senderIsOwner: allowed,
    isAuthorizedSender: allowed,
  });
  for (const identity of [entry, `id:${entry}`]) {
    expect(elevated(context, [identity])).toEqual(allowed ? elevatedAllowed : elevatedDenied());
  }
}

describe("gateway client identity", () => {
  it("sender provenance comes only from a live verified profile", () => {
    const client = createClient({
      authenticatedUserId: "profile-id",
      authenticatedUserProfile: undefined,
    });
    expect(gatewayClientSenderFields(client)).toEqual({ sender: { id: "profile-id" } });
    client.authenticatedUserProfile = profile("profile-id", "Person");
    expect(gatewayClientSenderFields(client)).toEqual({
      sender: { id: "profile-id", name: "Person", identity: { type: "profile", id: "profile-id" } },
    });
    client.internal = { syntheticClient: true };
    expect(gatewayClientSenderFields(client).sender).not.toHaveProperty("identity");
  });

  it("overrides sender attribution without replacing the authorizing identity", () => {
    const sender = {
      id: "alice",
      name: "Suggested by Alice",
      identity: { type: "profile" as const, id: "alice" },
    };
    const client = createClient({
      authenticatedUserProfile: profile("owner", "Owner"),
      internal: { syntheticClient: true, senderAttribution: sender },
    });

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

const agentToolCaller = { agentId: "main", sessionKey: "agent:main:tool" };
type RetireCaller = (client: GatewayClient, lifetime: AbortController, revoke: () => void) => void;

describe("chat send command authority", () => {
  it.each<[string, Partial<GatewayClient>, boolean]>([
    ["verified human", {}, true],
    [
      "shared gateway-owner attribution",
      {
        authenticatedUserId: undefined,
        authenticatedUserProfile: profile(GATEWAY_OWNER_PROFILE_ID, "Owner"),
      },
      false,
    ],
    ["unresolved profile", { authenticatedUserProfile: undefined }, false],
    ["synthetic caller", { internal: { syntheticClient: true } }, false],
    ["agent tool caller", { internal: { agentToolCaller } }, false],
  ])("matches human allowlists only for %s", (_name, overrides, allowed) => {
    const context = resolveChatSendCallerContext(createClient(overrides));
    expectAuthority(context, allowed);
    expectAuthority(context, false, "profile-other");
    expect(context).not.toHaveProperty("SenderId");
    if (allowed) {
      expect(elevated(context, ["*"], ["profile-ada"])).toEqual(elevatedAllowed);
      expect(elevated(context, ["*"], ["profile-other"])).toEqual(
        elevatedDenied("agents.entries.*.tools.elevated.allowFrom.webchat"),
      );
      expect(elevated(context, ["profile-other"], ["profile-ada"])).toEqual(elevatedDenied());
      for (const field of ["name", "username", "tag", "from", "e164"]) {
        expect(elevated(context, [`${field}:profile-ada`])).toEqual(elevatedDenied());
      }
    } else {
      expect(elevated(context, [GATEWAY_OWNER_PROFILE_ID, "profile-ada"], ["profile-ada"])).toEqual(
        elevatedDenied(),
      );
    }
  });

  it.each(["revoked", "aborted", "rebound", "synthetic"] as const)(
    "uses live delegated authority and rejects %s",
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
      client.internal = {
        operatorRoleActor: principal.operatorRoleActor,
        remoteIngressPrincipal: principal,
      };
      const context = resolveChatSendCallerContext(client);
      expectAuthority(context, true);
      expectAuthority(context, false, "profile-other");
      if (change === "revoked") {
        current = false;
      } else if (change === "aborted") {
        lifetime.abort();
      } else if (change === "rebound") {
        client.authenticatedUserProfile!.profileId = "profile-other";
      } else {
        client.internal.syntheticClient = true;
      }
      expectAuthority(context, false);
    },
  );

  it("preserves shipped CLI allowlists without a profile", () => {
    const client = createClient({ authenticatedUserProfile: undefined });
    client.connect.client = createClientInfo({ displayName: "CLI" });
    const context = resolveChatSendCallerContext(client);
    expectAuthority(context, true, "cli");
    expect(context).toMatchObject({ SenderId: "cli", SenderName: "CLI", SenderUsername: "CLI" });
    client.authenticatedUserProfile = profile("profile-ada", "Ada");
    expectAuthority(resolveChatSendCallerContext(client), true);
    expectAuthority(resolveChatSendCallerContext(client), true, "cli");
    expectAuthority(resolveChatSendCallerContext(createClient()), false, "cli");
  });

  it.each<[string, RetireCaller]>([
    ["profile", (client) => (client.authenticatedUserProfile!.profileId = "profile-bob")],
    [
      "profile-replacement",
      (client) => (client.authenticatedUserProfile = profile("profile-other", "Other", 2)),
    ],
    ["identity", (client) => (client.authenticatedUserId = "bob@example.test")],
    ["disconnect", (_client, lifetime) => lifetime.abort()],
    ["invalidated", (client) => (client.invalidated = true)],
    ["admission", (_client, _lifetime, revokeAdmission) => revokeAdmission()],
    ["synthetic", (client) => (client.internal = { syntheticClient: true })],
    ["owner", (client) => (client.internal = {})],
  ])("retires verified requester context after %s changes", (change, retire) => {
    const lifetime = new AbortController();
    const client = createClient({
      authenticatedUserId: change === "owner" ? undefined : "ada@example.test",
      internal: change === "owner" ? { authenticatedOperator: true } : undefined,
      connectionSignal: lifetime.signal,
    });
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
    expect(ctx.Provider).toBe("webchat");
    expectAuthority(finalizeInboundContext({ ...ctx }), change !== "owner");
    const render = () => buildInboundUserContextPrefix(finalizeInboundContext({ ...ctx }));
    expect(render()).toContain("requester_profile");
    expect(render()).toContain("profile-ada");
    retire(client, lifetime, () => {
      current = false;
    });
    expect(render()).not.toContain("requester_profile");
    expect(ctx).not.toHaveProperty("SenderId");
    if (change !== "admission" && change !== "identity") {
      expectAuthority(finalizeInboundContext({ ...ctx }), false);
    }
  });

  it("does not inherit human or application candidates from ambient agent work", async () => {
    const client = createClient();
    client.connect.client.id = "cli";
    await withGatewayToolCallerIdentity(agentToolCaller, () => {
      const context = resolveChatSendCallerContext(client);
      expectAuthority(context, false);
      expectAuthority(context, false, "cli");
    });
  });
});
