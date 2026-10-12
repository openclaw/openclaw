import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { formatAllowFromLowercase } from "../../plugin-sdk/allow-from.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../../plugins/runtime.js";
import { linkUserChannelIdentity } from "../../state/user-channel-identities.js";
import { publishCanonicalUserChannelPolicy } from "../../state/user-channel-identity-operations.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
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
  channelId: "discord" | "slack" = "discord",
) {
  const registry = channelId === "slack" ? captureActivePluginRegistrySnapshot() : undefined;
  if (registry) {
    stageActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: createChannelTestPluginBase({
            id: "slack",
            config: { formatAllowFrom: ({ allowFrom }) => formatAllowFromLowercase({ allowFrom }) },
          }),
          source: "test",
        },
      ]),
      null,
      "default",
    );
  }
  try {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = await createFixture(state, authority, channelId);
      try {
        await run(fixture);
      } finally {
        fixture.unregister();
      }
    });
  } finally {
    if (registry) {
      rollbackStagedPluginRegistry(registry);
    }
  }
}

async function createFixture(
  state: OpenClawTestState,
  authority: "role" | "identity-grant",
  channelId: "discord" | "slack",
) {
  const cfg: OpenClawConfig = {
    channels: { [channelId]: { accounts: { team: { allowFrom: ["*"] } } } },
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
    const identity = {
      channelId,
      accountId: "team",
      senderId: channelId === "slack" ? `U00000${index + 100}` : String(index + 100),
    };
    linkUserChannelIdentity(profile.id, identity);
    return { profile, identity };
  });
  const activatePolicy = async (update: Partial<NonNullable<OpenClawConfig["gateway"]>>) => {
    const gateway = { ...cfg.gateway, ...update };
    await publishCanonicalUserChannelPolicy(gateway, cfg.commands?.ownerAllowFrom);
    cfg.gateway = gateway;
  };
  await activatePolicy({});
  let live = true;
  let gateway = createCommandOwnerTestGateway(cfg);
  const owner = {
    channelId,
    isLive: () => live,
    resolveGatewayContext: () => gateway,
  };
  const unregister = () => {
    live = false;
  };
  const ingressRuntime = createHostChannelIngressRuntime(owner);
  const key = `agent:main:${channelId}:channel:maintainers`;
  const context = async (senderId: string, verified = true, accountId = "team") => {
    const ingress = await ingressRuntime.resolveStable({
      channelId,
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
      channel: channelId,
      accountId,
      messageId: senderId,
      from: `${channelId}:${senderId}`,
      sender: { id: senderId },
      conversation: { kind: "direct", id: "conversation" },
      route: { agentId: "main", routeSessionKey: key },
      reply: { to: `${channelId}:${senderId}` },
      message: { rawBody: "Assign this session to the requester" },
      channelIngress: ingress,
    });
  };
  return {
    cfg,
    activatePolicy,
    state,
    admins,
    gateway,
    context,
    replaceGatewayContext: (replacement?: GatewayRequestContext) => {
      gateway = replacement ?? createCommandOwnerTestGateway(cfg);
    },
    unregister,
    retire: () => {
      live = false;
    },
  };
}
