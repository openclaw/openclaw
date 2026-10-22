import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { buildConversationIdentity } from "../config/sessions/conversation-identity.js";
import {
  listConversations,
  registerConversationAddresses,
  prepareConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOutboundSessionRoute } from "../infra/outbound/outbound-session.js";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "../infra/outbound/session-binding-service.js";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugin-sdk/plugin-test-runtime.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { runGatewayConversationList } from "./conversation-list.js";

const LIVE_ACCOUNT_ID = "default";
type ChannelFixture = readonly [channel: string, peerId: string];
const CHANNELS: ChannelFixture[] = [
  ["matrix", "!room:example.org"],
  ["telegram", "-1001234567890"],
  ["slack", "C01234567"],
];
const discordPeer = "123456789012345678";

let plugins: ChannelPlugin[];
const unboundAdapter = { listBySession: () => [], resolveByConversation: () => null };
beforeAll(async () => {
  plugins = await Promise.all(
    [...CHANNELS.map(([channel]) => channel), "discord"].map(async (channel) => {
      const facade = await loadBundledPluginFacade<Record<string, ChannelPlugin>>({
        pluginId: channel,
        artifactBasename: "api.js",
      });
      return expectDefined(facade[`${channel}Plugin`], `${channel} channel plugin`);
    }),
  );
});

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(
    createTestRegistry(plugins.map((plugin) => ({ pluginId: plugin.id, source: "test", plugin }))),
  );
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  // Only the live account still has a running monitor, so only it registers an adapter.
  for (const { id: channel } of plugins) {
    registerSessionBindingAdapter({ channel, accountId: LIVE_ACCOUNT_ID, ...unboundAdapter });
  }
});

const tempDirs = useSessionStoreTempDirs(afterEach, "channel-conversation-list-");
afterEach(() => {
  resetPluginRuntimeStateForTest();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  vi.unstubAllEnvs();
});

async function createConversationStore(channels: ChannelFixture[]) {
  const stateDir = tempDirs.make();
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const storePath = path.join(stateDir, "main.sqlite");
  openOpenClawAgentDatabase({ agentId: "main", path: storePath });
  const config: OpenClawConfig = {
    agents: { entries: { main: {} } },
    channels: Object.fromEntries(
      channels.map(([channel]) => [channel, { accounts: { [LIVE_ACCOUNT_ID]: {} } }]),
    ),
    session: { store: storePath },
  };
  return { config, scope: await prepareConversationRegistryScope({ config, agentId: "main" }) };
}

const deps = {
  listConversations,
  registerConversationAddresses,
  resolveOutboundChannelPlugin: () => undefined,
  resolveOutboundSessionRoute,
};

it.each([false, true])("preserves retired history (Discord search: %s)", async (search) => {
  const channels: ChannelFixture[] = search ? [["discord", discordPeer]] : CHANNELS;
  const { config, scope } = await createConversationStore(channels);
  const retired = search ? ["retired-one", "retired-two"] : ["retired"];
  // Without its monitor, Slack has no workspace identity: seed only retired history.
  const identities = channels.flatMap(([channel, peerId]) =>
    [...retired, ...(channel === "slack" ? [] : [LIVE_ACCOUNT_ID])].map((accountId) =>
      expectDefined(
        buildConversationIdentity({
          kind: "channel",
          channel,
          peerId,
          nativeChannelId: channel === "telegram" ? undefined : peerId,
          deliveryTarget: channel === "discord" ? `channel:${peerId}` : peerId,
          accountId,
        }),
        `synthetic ${channel} identity`,
      ),
    ),
  );
  await registerConversationAddresses(scope, identities);
  const before = await listConversations(scope);
  expect(before).toHaveLength(search ? 3 : identities.length);
  const { conversations } = await runGatewayConversationList(
    {
      config,
      agentId: "main",
      limit: 10,
      ...(search ? { channel: "discord", query: discordPeer } : {}),
    },
    deps,
  );
  expect(conversations.map(({ channel, accountId }) => ({ channel, accountId }))).toEqual(
    channels
      .filter(([channel]) => channel !== "slack")
      .map(([channel]) => ({ channel, accountId: LIVE_ACCOUNT_ID })),
  );
  if (search) {
    expect(conversations).toEqual([
      expect.objectContaining({
        conversationRef: expectDefined(identities[2], "active account identity").conversationRef,
        accountId: LIVE_ACCOUNT_ID,
        target: `channel:${discordPeer}`,
      }),
    ]);
  }
  expect(await listConversations(scope)).toEqual(before);
});
