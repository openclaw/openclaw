import { afterEach, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveHeartbeatDeliveryTargetWithSessionRoute } from "./targets.js";

const cfg: OpenClawConfig = {
  channels: {
    telegram: {
      accounts: {
        work: { botToken: "work-test-token", allowFrom: ["*"] },
        personal: { botToken: "personal-test-token", allowFrom: ["*"] },
      },
    },
  },
};
const snapshot = captureActivePluginRegistrySnapshot();
const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
  pluginId: "telegram",
  artifactBasename: "api.ts",
});
afterEach(() => restoreActivePluginRegistrySnapshot(snapshot));

it.each(["telegram:-1003774691294:topic:47", "tg:-1003774691294:47", "-1003774691294"])(
  "keeps real plugin exec authority while normalizing %s",
  async (to) => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
    );
    const result = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg,
      agentId: "main",
      heartbeat: { target: "telegram", to: "1234567890", accountId: "personal" },
      turnSource: { channel: "telegram", to, threadId: 47, accountId: "work" },
      turnSourceKind: "exec",
    });
    expect(result).toMatchObject({
      channel: "telegram",
      to: "telegram:-1003774691294:topic:47",
      accountId: "work",
      threadId: 47,
      chatType: "group",
    });
  },
);

it("rejects real-plugin embedded topic and post-await explicit thread disagreement", async () => {
  const plugin: ChannelPlugin = {
    ...telegramPlugin,
    messaging: {
      ...telegramPlugin.messaging,
      resolveOutboundSessionRoute: async (params) => {
        const route = await telegramPlugin.messaging!.resolveOutboundSessionRoute!(params);
        return route ? { ...route, threadId: 99 } : null;
      },
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]));
  const result = await resolveHeartbeatDeliveryTargetWithSessionRoute({
    cfg,
    agentId: "main",
    heartbeat: { target: "telegram", to: "1234567890", accountId: "personal" },
    turnSource: {
      channel: "telegram",
      to: "telegram:-1003774691294:topic:47",
      accountId: "work",
      threadId: 47,
    },
    turnSourceKind: "exec",
  });
  expect(result).toMatchObject({ channel: "none", reason: "exec-route-conflict" });
});

it.each([
  ["native private thread", "telegram:123456789:topic:42", "42", true],
  ["scoped private thread", "telegram:123456789:topic:42", "123456789:42", true],
  ["scoped plain private chat", "telegram:123456789", "123456789:42", true],
  ["cross scoped chat", "telegram:123456789:topic:42", "987654321:42", false],
  ["cross scoped topic", "telegram:123456789:topic:42", "123456789:99", false],
  [
    "cross scoped channel-DM topic",
    "telegram:123456789:topic:42",
    "123456789:direct-topic:42",
    false,
  ],
] as const)("retains real-plugin authority for %s", async (_label, to, threadId, allowed) => {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
  );
  const result = await resolveHeartbeatDeliveryTargetWithSessionRoute({
    cfg,
    agentId: "main",
    heartbeat: { target: "telegram", to: "1234567890", accountId: "personal" },
    turnSource: { channel: "telegram", to, threadId, accountId: "work" },
    turnSourceKind: "exec",
  });
  if (allowed) {
    expect(result).toMatchObject({
      channel: "telegram",
      to: "telegram:123456789:topic:42",
      accountId: "work",
      threadId: 42,
      chatType: "direct",
    });
  } else {
    // Scoped tuple disagreement is rejected before target refinement.
    expect(result).toMatchObject({ channel: "none", reason: "no-route" });
  }
});

it.each([
  ["explicit lowercase", "-100155462274", "-100155462274:direct-topic:42"],
  ["explicit uppercase", "-100155462274", "-100155462274:DIRECT-TOPIC:42"],
  ["embedded uppercase", "-100155462274:DIRECT-TOPIC:42", undefined],
] as const)(
  "preserves verified Direct Messages scope from producer through the real final resolver (%s)",
  async (_label, to, threadId) => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
    );
    const turnSource = { channel: "telegram", to, accountId: "work", threadId };
    const result = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg,
      agentId: "main",
      heartbeat: { target: "telegram", to: "1234567890", accountId: "personal" },
      turnSource,
      turnSourceKind: "exec",
    });
    expect(result).toMatchObject({
      channel: "telegram",
      to: "telegram:-100155462274:direct-topic:42",
      accountId: "work",
      threadId: 42,
    });
  },
);

it.each(["target throws", "target rejects", "session throws", "session declines"] as const)(
  "ordinary heartbeat retains configured delivery when %s",
  async (failure) => {
    const messaging: NonNullable<ChannelPlugin["messaging"]> = { ...telegramPlugin.messaging };
    const plugin: ChannelPlugin = { ...telegramPlugin, messaging };
    if (failure === "target throws") {
      messaging.targetResolver = {
        looksLikeId: () => {
          throw new Error("target failed");
        },
      };
    } else if (failure === "target rejects") {
      messaging.targetResolver = { looksLikeId: () => false };
      plugin.directory = {
        listGroups: async () => [
          { kind: "group", id: "-1003774691294:topic:47", name: "first" },
          { kind: "group", id: "-1003774691294:topic:47", name: "second" },
        ],
      };
    } else {
      messaging.resolveOutboundSessionRoute = async () => {
        if (failure === "session throws") {
          throw new Error("session failed");
        }
        return null;
      };
    }
    setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]));
    const result = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg,
      agentId: "main",
      heartbeat: { target: "telegram", to: "telegram:-1003774691294:topic:47", accountId: "work" },
    });
    expect(result).toMatchObject({ channel: "telegram", accountId: "work" });
    expect(result.to).toBe("telegram:-1003774691294:topic:47");
  },
);
