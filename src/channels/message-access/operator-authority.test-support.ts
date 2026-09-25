import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { linkUserChannelIdentity } from "../../state/user-channel-identities.js";
import { publishCanonicalUserChannelPolicy } from "../../state/user-channel-identity-operations.js";
import { ensureProfileForEmail, setUserProfileRole } from "../../state/user-profiles.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { buildChannelInboundEventContext } from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import { createHostChannelIngressRuntime } from "./runtime.js";

export function createCommandOwnerTestGateway(cfg: OpenClawConfig) {
  // SAFETY: Ingress authority only consumes runtime config from this synthetic Gateway.
  return { getRuntimeConfig: () => cfg } as GatewayRequestContext;
}

export async function withAdminIngress(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  authority: "role" | "identity-grant" = "role",
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await createFixture(state, authority);
    try {
      await run(fixture);
    } finally {
      fixture.unregister();
    }
  });
}

async function createFixture(state: OpenClawTestState, authority: "role" | "identity-grant") {
  const cfg: OpenClawConfig = {
    channels: { discord: { accounts: { team: { allowFrom: ["*"] } } } },
    commands: { ownerAllowFrom: ["whatsapp:15550000000"] },
    gateway: {
      roles: {
        default: "member",
        definitions: {
          admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
          member: {
            scopes: ["operator.read", "operator.write"],
            agents: "*",
            sessions: { others: "view" },
          },
        },
      },
    },
  };
  if (authority === "identity-grant") {
    cfg.gateway = {
      auth: {
        identityScopes: {
          "ada@example.test": ["operator.admin"],
          "grace@example.test": ["operator.admin"],
        },
      },
    };
  }
  const admins = ["ada", "grace"].map((name, index) => {
    const profile = ensureProfileForEmail(`${name}@example.test`);
    setUserProfileRole(profile.id, "admin");
    const identity = { channelId: "discord", accountId: "team", senderId: String(index + 100) };
    linkUserChannelIdentity(profile.id, identity);
    return { profile, identity };
  });
  const activatePolicy = async (update: Partial<NonNullable<OpenClawConfig["gateway"]>>) => {
    const gateway = { ...cfg.gateway, ...update };
    await publishCanonicalUserChannelPolicy(gateway);
    cfg.gateway = gateway;
  };
  await activatePolicy({});
  let live = true;
  const gateway = createCommandOwnerTestGateway(cfg);
  const owner = {
    channelId: "discord",
    isLive: () => live,
    resolveGatewayContext: () => gateway,
  };
  const unregister = () => {
    live = false;
  };
  const ingressRuntime = createHostChannelIngressRuntime(owner);
  const key = "agent:main:discord:channel:maintainers";
  const context = async (senderId: string, verified = true, accountId = "team") => {
    const ingress = await ingressRuntime.resolveStable({
      channelId: "discord",
      accountId,
      identity: { authentication: "verified" },
      subject: {
        stableId: senderId,
        ...(verified ? {} : { authentication: { stableId: "asserted" as const } }),
      },
      conversation: { kind: "direct", id: "conversation" },
      contextBinding: {
        agentId: "main",
        sessionKey: key,
        messageId: senderId,
        inboundEventKind: "user_request",
      },
      dmPolicy: "open",
      groupPolicy: "disabled",
      allowFrom: ["*"],
      useDefaultPairingStore: false,
    });
    return await createHostChannelInboundEventContextBuilder(
      buildChannelInboundEventContext,
      owner,
    )({
      channel: "discord",
      accountId,
      messageId: senderId,
      from: `discord:${senderId}`,
      sender: { id: senderId },
      conversation: { kind: "direct", id: "conversation" },
      route: { agentId: "main", routeSessionKey: key },
      reply: { to: `discord:${senderId}` },
      message: { rawBody: "Assign this session to the requester" },
      channelIngress: ingress,
    });
  };
  return {
    cfg,
    activatePolicy,
    state,
    admins,
    context,
    unregister,
    retire: () => {
      live = false;
    },
  };
}
