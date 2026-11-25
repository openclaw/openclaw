// A channel whose transport authenticates the sender declares it `verified`; then a sender listed in
// `commands.ownerAllowFrom` is the Gateway owner, with the same grant as the owner's Control UI turn.
// Each cell runs the channel's real identity declaration through the real host ingress and context
// builder, with the real plugin registered so owner entries use its allowlist normalizer.
import { describe, expect, it } from "vitest";
import { buzzPlugin } from "../extensions/buzz/api.js";
import { buzzIngressIdentity } from "../extensions/buzz/test-api.js";
import { clickClackPlugin } from "../extensions/clickclack/api.js";
import { clickClackIngressIdentity } from "../extensions/clickclack/test-api.js";
import { linePlugin } from "../extensions/line/api.js";
import { lineIngressIdentity } from "../extensions/line/test-api.js";
import { matrixPlugin } from "../extensions/matrix/api.js";
import {
  resolveMatrixMonitorAccessState,
  setMatrixRuntime,
} from "../extensions/matrix/test-api.js";
import { msteamsPlugin } from "../extensions/msteams/api.js";
import { resolveMSTeamsSenderAccess, setMSTeamsRuntime } from "../extensions/msteams/test-api.js";
import { nextcloudTalkPlugin } from "../extensions/nextcloud-talk/api.js";
import { nextcloudTalkIngressIdentity } from "../extensions/nextcloud-talk/test-api.js";
import { nostrPlugin } from "../extensions/nostr/api.js";
import { nostrIngressIdentity } from "../extensions/nostr/test-api.js";
import { signalPlugin } from "../extensions/signal/api.js";
import { resolveSignalAccessState, setSignalRuntime } from "../extensions/signal/test-api.js";
import { setSynologyRuntime, synologyChatPlugin } from "../extensions/synology-chat/api.js";
import { authorizeUserForDmWithIngress } from "../extensions/synology-chat/test-api.js";
import { twitchPlugin } from "../extensions/twitch/api.js";
import { twitchRoleIdentity, twitchUserIdentity } from "../extensions/twitch/test-api.js";
import { whatsappPlugin } from "../extensions/whatsapp/api.js";
import {
  resolveWhatsAppIngressAccess,
  resolveWhatsAppInboundPolicy,
  setWhatsAppRuntime,
} from "../extensions/whatsapp/test-api.js";
import { zaloPlugin } from "../extensions/zalo/api.js";
import { zaloIngressIdentity } from "../extensions/zalo/test-api.js";
import { zalouserPlugin } from "../extensions/zalouser/api.js";
import { zalouserIngressIdentity } from "../extensions/zalouser/test-api.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../packages/gateway-protocol/src/schema/users.js";
import { getCommandOwnerAuthority } from "../src/auto-reply/command-owner-authority.js";
import {
  createHostIngressFixture,
  ingressMessage,
} from "../src/channels/message-access/host-ingress.test-support.js";
import { defineStableChannelIngressIdentity } from "../src/channels/message-access/runtime-identity.js";
import type {
  ChannelIngressContextBinding,
  ChannelIngressIdentityDescriptor,
  ResolvedChannelMessageIngress,
  StableChannelIngressIdentityParams,
} from "../src/channels/message-access/runtime-types.js";
import type { AnyChannelPlugin } from "../src/channels/plugins/types.plugin.js";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createPluginRuntimeMock } from "../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";
import { publishCanonicalUserChannelPolicy } from "../src/state/user-channel-identity-operations.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

type Resolve = (params: {
  runtime: PluginRuntime;
  cfg: OpenClawConfig;
  contextBinding: ChannelIngressContextBinding;
}) => Promise<ResolvedChannelMessageIngress>;
type Cell = {
  plugin: AnyChannelPlugin;
  /** The `commands.ownerAllowFrom` entry an owner writes for this channel. */
  owner: string;
  /** The native sender id the channel puts on the inbound context. */
  senderId: string;
  /** Resolves one owner message through the channel's ingress code or its exported declaration. */
  resolve: Resolve;
};

// For channels whose ingress call sits inside a transport loop, run their exported declaration.
const declared =
  (
    identity: StableChannelIngressIdentityParams | ChannelIngressIdentityDescriptor,
    senderId: string,
  ): Resolve =>
  async ({ runtime, cfg, contextBinding }) => {
    const params = {
      channelId: contextBinding.sessionKey.split(":")[2]!,
      accountId: "default",
      cfg,
      subject: { stableId: senderId },
      conversation: { kind: "direct" as const, id: senderId },
      contextBinding,
      dmPolicy: "open" as const,
      groupPolicy: "disabled" as const,
      allowFrom: ["*"],
    };
    const descriptor =
      "primary" in identity ? identity : defineStableChannelIngressIdentity(identity);
    return await runtime.channel.inbound.ingress
      .createResolver({ ...params, identity: descriptor })
      .message(params);
  };

async function admitOwner(cell: Cell) {
  const channelId = cell.plugin.id;
  const previous = captureActivePluginRegistrySnapshot();
  // The real plugin owns its allowlist normalizer, which owner matching uses.
  const registry = createTestRegistry([
    { pluginId: channelId, plugin: cell.plugin, source: "test" },
  ]);
  stageActivePluginRegistry(registry, null, "default");
  try {
    return await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg: OpenClawConfig = { commands: { ownerAllowFrom: [cell.owner] } };
      setRuntimeConfigSnapshot(cfg);
      // The Gateway publishes the configured owner policy at startup; ingress reads it.
      await publishCanonicalUserChannelPolicy(cfg.gateway, cfg.commands?.ownerAllowFrom);
      const host = createHostIngressFixture(channelId, cfg);
      const runtime = createPluginRuntimeMock();
      runtime.channel.inbound.ingress = host.ingress;
      const message = ingressMessage(
        channelId,
        `agent:main:${channelId}:direct:owner`,
        cell.senderId,
        {
          conversation: { kind: "direct", id: cell.senderId },
        },
      );
      const channelIngress = await cell.resolve({
        runtime,
        cfg,
        contextBinding: {
          agentId: message.route.agentId,
          sessionKey: message.route.routeSessionKey,
          messageId: message.messageId,
          inboundEventKind: "user_request",
        },
      });
      const ctx = host.buildContext({ ...message, channelIngress });
      return getCommandOwnerAuthority(ctx)?.operatorAuthority;
    });
  } finally {
    rollbackStagedPluginRegistry(previous);
  }
}

const open = { dmPolicy: "open" as const, allowFrom: ["*"] };
const NOSTR_PUBKEY = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";
const cells: Record<string, Cell> = {
  whatsapp: {
    plugin: whatsappPlugin,
    owner: "whatsapp:+15550001111",
    senderId: "+15550001111",
    resolve: async ({ runtime, cfg, contextBinding }) => {
      setWhatsAppRuntime(runtime);
      return await resolveWhatsAppIngressAccess({
        cfg,
        policy: resolveWhatsAppInboundPolicy({ cfg: { ...cfg, channels: { whatsapp: open } } }),
        isGroup: false,
        conversationId: "+15550001111",
        senderId: "+15550001111",
        contextBinding,
      });
    },
  },
  signal: {
    plugin: signalPlugin,
    owner: "signal:+15550001111",
    senderId: "+15550001111",
    resolve: async ({ runtime, cfg, contextBinding }) => {
      setSignalRuntime(runtime);
      return await resolveSignalAccessState({
        cfg,
        accountId: "default",
        groupPolicy: "disabled",
        groupAllowFrom: [],
        sender: { kind: "phone", raw: "+15550001111", e164: "+15550001111" },
        readStoreAllowFrom: async () => [],
        contextBinding,
        ...open,
      });
    },
  },
  matrix: {
    plugin: matrixPlugin,
    owner: "matrix:@owner:example.org",
    senderId: "@owner:example.org",
    resolve: async ({ runtime, contextBinding }) => {
      setMatrixRuntime(runtime);
      const state = await resolveMatrixMonitorAccessState({
        accountId: "default",
        senderId: "@owner:example.org",
        isRoom: false,
        conversationId: "@owner:example.org",
        storeAllowFrom: [],
        groupAllowFrom: [],
        roomUsers: [],
        ...open,
      });
      return await state.resolveMessageIngress(contextBinding);
    },
  },
  msteams: {
    plugin: msteamsPlugin,
    owner: "msteams:11111111-2222-4333-8444-555555555555",
    senderId: "11111111-2222-4333-8444-555555555555",
    resolve: async ({ runtime, cfg, contextBinding }) => {
      setMSTeamsRuntime(runtime);
      const access = await resolveMSTeamsSenderAccess({
        cfg: { ...cfg, channels: { msteams: open } },
        accountId: "default",
        activity: {
          type: "message",
          from: { id: "29:owner", aadObjectId: "11111111-2222-4333-8444-555555555555" },
          conversation: {
            id: "11111111-2222-4333-8444-555555555555",
            conversationType: "personal",
          },
        },
        contextBinding,
      });
      return access.channelIngress;
    },
  },
  "synology-chat": {
    plugin: synologyChatPlugin,
    owner: "synology-chat:1042",
    senderId: "1042",
    resolve: async ({ runtime, contextBinding }) => {
      setSynologyRuntime(runtime);
      return await authorizeUserForDmWithIngress({
        accountId: "default",
        userId: "1042",
        dmPolicy: "open",
        allowedUserIds: ["*"],
        contextBinding,
      });
    },
  },
  line: {
    plugin: linePlugin,
    owner: "line:U0123456789abcdef0123456789abcdef",
    senderId: "U0123456789abcdef0123456789abcdef",
    resolve: declared(lineIngressIdentity, "U0123456789abcdef0123456789abcdef"),
  },
  "nextcloud-talk": {
    plugin: nextcloudTalkPlugin,
    owner: "nextcloud-talk:users/alice",
    senderId: "users/alice",
    resolve: declared(nextcloudTalkIngressIdentity, "users/alice"),
  },
  zalo: {
    plugin: zaloPlugin,
    owner: "zalo:847291605384129",
    senderId: "847291605384129",
    resolve: declared(zaloIngressIdentity, "847291605384129"),
  },
  zalouser: {
    plugin: zalouserPlugin,
    owner: "zalouser:847291605384129",
    senderId: "847291605384129",
    resolve: declared(zalouserIngressIdentity, "847291605384129"),
  },
  nostr: {
    plugin: nostrPlugin,
    owner: `nostr:${NOSTR_PUBKEY}`,
    senderId: NOSTR_PUBKEY,
    resolve: declared(nostrIngressIdentity, NOSTR_PUBKEY),
  },
  buzz: {
    plugin: buzzPlugin,
    owner: `buzz:${NOSTR_PUBKEY}`,
    senderId: NOSTR_PUBKEY,
    resolve: declared(buzzIngressIdentity, NOSTR_PUBKEY),
  },
  twitch: {
    plugin: twitchPlugin,
    owner: "twitch:141981764",
    senderId: "141981764",
    resolve: declared(twitchUserIdentity, "141981764"),
  },
  "twitch (role policy)": {
    plugin: twitchPlugin,
    owner: "twitch:141981764",
    senderId: "141981764",
    resolve: declared(twitchRoleIdentity, "141981764"),
  },
  clickclack: {
    plugin: clickClackPlugin,
    owner: "clickclack:usr_owner",
    senderId: "usr_owner",
    resolve: declared(clickClackIngressIdentity, "usr_owner"),
  },
};

describe("configured channel owner", () => {
  it.each(Object.entries(cells))("%s owner gets the owner grant", async (_channel, cell) => {
    const authority = await admitOwner(cell);
    expect(authority?.profileId).toBe(GATEWAY_OWNER_PROFILE_ID);
    expect(authority?.scopes).toContain("operator.admin");
  });
});
