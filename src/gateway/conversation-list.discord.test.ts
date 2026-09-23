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

let discordPlugin: ChannelPlugin;
beforeAll(async () => {
  ({ discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
    pluginId: "discord",
    artifactBasename: "api.js",
  }));
});

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordPlugin }]),
  );
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  registerSessionBindingAdapter({
    channel: "discord",
    accountId: "default",
    listBySession: () => [],
    resolveByConversation: () => null,
  });
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Discord conversation listings after removing accounts", () => {
  it.each([undefined, "123456789012345678"])(
    "lists the active account and preserves inactive history with query %s",
    async (query) => {
      const stateDir = tempDirs.make("discord-conversation-list-");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const storePath = path.join(stateDir, "main.sqlite");
      openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      const config: OpenClawConfig = {
        agents: { entries: { main: { default: true } } },
        channels: { discord: { accounts: { default: {} } } },
        session: { store: storePath },
      };
      const scope = resolveConversationRegistryScope({ config, agentId: "main" });
      const identities = ["retired-one", "retired-two", "default"].map((accountId) => {
        const identity = buildConversationIdentity({
          channel: "discord",
          accountId,
          kind: "channel",
          peerId: "123456789012345678",
          deliveryTarget: "channel:123456789012345678",
          nativeChannelId: "123456789012345678",
        });
        return expectDefined(identity, "synthetic Discord conversation identity");
      });
      registerConversationAddresses(scope, identities);
      const before = listConversations(scope);

      const result = await runGatewayConversationList(
        { config, agentId: "main", channel: "discord", query, limit: 10 },
        {
          listConversations,
          registerConversationAddresses,
          resolveOutboundChannelPlugin: () => undefined,
          resolveOutboundSessionRoute,
        },
      );

      expect(result.conversations).toEqual([
        expect.objectContaining({
          conversationRef: expectDefined(identities[2], "active account identity").conversationRef,
          accountId: "default",
          target: "channel:123456789012345678",
        }),
      ]);
      expect(listConversations(scope)).toEqual(before);
      expect(before).toHaveLength(3);
    },
  );
});
