import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { buildConversationIdentity } from "../config/sessions/conversation-identity.js";
import {
  listConversations,
  registerConversationAddresses,
  resolveConversationRegistryScope,
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
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { runGatewayConversationList } from "./conversation-list.js";

// The live channels keep a session-binding adapter only while their monitor runs, so an
// account the operator removed looks exactly like an adapter that is temporarily missing.
const LIVE_ACCOUNT_ID = "default";
const RETIRED_ACCOUNT_ID = "retired";
const CHANNELS: Array<{
  channel: string;
  peerId: string;
  nativeChannelId?: string;
  retiredOnly?: boolean;
}> = [
  { channel: "matrix", peerId: "!room:example.org", nativeChannelId: "!room:example.org" },
  { channel: "telegram", peerId: "-1001234567890" },
  // Slack additionally needs workspace installation identity from its running monitor, which an
  // isolated listing cannot supply, so only its retired history is seeded here.
  { channel: "slack", peerId: "C01234567", nativeChannelId: "C01234567", retiredOnly: true },
];
const LIVE_CHANNELS = CHANNELS.filter((entry) => !entry.retiredOnly);

let plugins: ChannelPlugin[];
beforeAll(async () => {
  plugins = await Promise.all(
    CHANNELS.map(async ({ channel }) => {
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
  for (const { channel } of CHANNELS) {
    registerSessionBindingAdapter({
      channel,
      accountId: LIVE_ACCOUNT_ID,
      listBySession: () => [],
      resolveByConversation: () => null,
    });
  }
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("conversation listings after removing matrix, telegram and slack accounts", () => {
  it("lists live conversations across channels and preserves retired history", async () => {
    const stateDir = tempDirs.make("channel-conversation-list-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const storePath = path.join(stateDir, "main.sqlite");
    openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    const config: OpenClawConfig = {
      agents: { entries: { main: { default: true } } },
      channels: {
        matrix: { accounts: { [LIVE_ACCOUNT_ID]: {} } },
        telegram: { accounts: { [LIVE_ACCOUNT_ID]: {} } },
        slack: { accounts: { [LIVE_ACCOUNT_ID]: {} } },
      },
      session: { store: storePath },
    };
    const scope = resolveConversationRegistryScope({ config, agentId: "main" });
    const identities = CHANNELS.flatMap(({ channel, peerId, retiredOnly, ...rest }) =>
      (retiredOnly ? [RETIRED_ACCOUNT_ID] : [RETIRED_ACCOUNT_ID, LIVE_ACCOUNT_ID]).map(
        (accountId) =>
          expectDefined(
            buildConversationIdentity({
              channel,
              accountId,
              kind: "channel",
              peerId,
              deliveryTarget: peerId,
              ...rest,
            }),
            `synthetic ${channel} conversation identity`,
          ),
      ),
    );
    registerConversationAddresses(scope, identities);
    const before = listConversations(scope);
    expect(before).toHaveLength(identities.length);

    const result = await runGatewayConversationList(
      { config, agentId: "main", limit: 10 },
      {
        listConversations,
        registerConversationAddresses,
        resolveOutboundChannelPlugin: () => undefined,
        resolveOutboundSessionRoute,
      },
    );

    expect(
      result.conversations.map((conversation) => ({
        channel: conversation.channel,
        accountId: conversation.accountId,
      })),
    ).toEqual(LIVE_CHANNELS.map(({ channel }) => ({ channel, accountId: LIVE_ACCOUNT_ID })));
    expect(listConversations(scope)).toEqual(before);
  });
});
