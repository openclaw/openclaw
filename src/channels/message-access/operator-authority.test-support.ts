import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { formatAllowFromLowercase } from "../../plugin-sdk/allow-from.js";
import { linkUserChannelIdentity } from "../../state/user-channel-identities.js";
import { publishCanonicalUserChannelPolicy } from "../../state/user-channel-identity-operations.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { BuildChannelInboundEventContextParams } from "../inbound-event/context.js";
import {
  createHostIngressFixture,
  ingressInput,
  ingressMessage,
  withTestChannelRegistry,
} from "./host-ingress.test-support.js";

export const createCommandOwnerTestRoles = (): NonNullable<OpenClawConfig["gateway"]>["roles"] => ({
  default: "member",
  definitions: {
    admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
    member: {
      scopes: ["operator.read", "operator.write"],
      agents: "*",
      sessions: { others: "view" },
    },
  },
});

export async function withAdminIngress(
  run: (fixture: Awaited<ReturnType<typeof createAdminIngressFixture>>) => Promise<void>,
  authority: "role" | "identity-grant" = "role",
  channelId: "discord" | "slack" = "discord",
) {
  const plugin =
    channelId === "slack"
      ? createChannelTestPluginBase({
          id: "slack",
          config: { formatAllowFrom: ({ allowFrom }) => formatAllowFromLowercase({ allowFrom }) },
        })
      : undefined;
  await withTestChannelRegistry(plugin, () =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = await createAdminIngressFixture(state, authority, channelId);
      using _ = { [Symbol.dispose]: () => fixture.unregister() };
      await run(fixture);
    }),
  );
}

export async function createAdminIngressFixture(
  state: OpenClawTestState,
  authority: "role" | "identity-grant",
  channelId: "discord" | "slack",
) {
  const cfg: OpenClawConfig = {
    channels: { [channelId]: { accounts: { team: { allowFrom: ["*"] } } } },
    commands: { ownerAllowFrom: ["whatsapp:15550000000"] },
    gateway:
      authority === "role"
        ? { roles: createCommandOwnerTestRoles() }
        : {
            auth: {
              identityScopes: {
                "ada@example.test": ["operator.admin"],
                "grace@example.test": ["operator.admin"],
              },
            },
          },
  };
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
  setRuntimeConfigSnapshot(cfg);
  const host = createHostIngressFixture(channelId, cfg);
  const key = `agent:main:${channelId}:channel:maintainers`;
  const context = async (
    senderId: string,
    verified = true,
    accountId = "team",
    overrides: Partial<BuildChannelInboundEventContextParams> = {},
  ) => {
    const message = ingressMessage(channelId, key, senderId, {
      accountId,
      message: { rawBody: "Assign this session to the requester" },
      ...overrides,
    });
    const ingress = await host.ingress.resolveStable(
      ingressInput(message, {
        identity: { authentication: "verified" },
        subject: {
          stableId: senderId,
          ...(verified ? {} : { authentication: { stableId: "asserted" as const } }),
        },
      }),
    );
    return host.buildContext({ ...message, channelIngress: ingress });
  };
  return {
    cfg,
    activatePolicy,
    state,
    admins,
    gateway: host.gateway,
    resolveGatewayContext: host.owner.resolveGatewayContext,
    context,
    replaceGatewayContext: (replacement?: GatewayRequestContext) => {
      host.replaceGatewayContext(
        replacement ?? ({ getRuntimeConfig: () => cfg } as GatewayRequestContext),
      );
    },
    unregister: host.retire,
    retire: host.retire,
  };
}
