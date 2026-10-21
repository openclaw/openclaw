import { afterEach, beforeEach, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
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
const groupTopic = "telegram:-1003774691294:topic:47";
const privateTopic = "telegram:123456789:topic:42";
const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
  pluginId: "telegram",
  artifactBasename: "api.ts",
});
afterEach(() => restoreActivePluginRegistrySnapshot(snapshot));
function register(plugin = telegramPlugin) {
  setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]));
}
beforeEach(() => register());
type RouteParams = Parameters<typeof resolveHeartbeatDeliveryTargetWithSessionRoute>[0];
function resolveExec(
  source: Omit<NonNullable<RouteParams["turnSource"]>, "channel" | "accountId">,
  overrides: Partial<RouteParams> = {},
) {
  return resolveHeartbeatDeliveryTargetWithSessionRoute({
    cfg,
    agentId: "main",
    heartbeat: { target: "telegram", to: "1234567890", accountId: "personal" },
    turnSource: { channel: "telegram", accountId: "work", ...source },
    turnSourceKind: "exec",
    ...overrides,
  });
}
type Route = Awaited<ReturnType<typeof resolveExec>>;
function expectRoute(result: Route, expected: Pick<Route, "to" | "threadId" | "chatType">) {
  expect(result).toMatchObject({ channel: "telegram", accountId: "work", ...expected });
}

it("keeps real plugin exec authority while normalizing a topic", async () => {
  const result = await resolveExec({ to: groupTopic, threadId: 47 });
  expectRoute(result, { to: groupTopic, threadId: 47, chatType: "group" });
});

it("does not add a saved topic to a captured unthreaded exec route", async () => {
  const to = "-1003774691294";
  const result = await resolveExec(
    { to },
    {
      entry: {
        sessionId: "captured-unthreaded",
        updatedAt: 1,
        chatType: "group",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram", to, accountId: "work", threadId: 47 },
        }),
      },
      heartbeat: { target: "last" },
    },
  );
  expectRoute(result, { to: `telegram:${to}`, chatType: "group" });
  expect(result.threadId).toBeUndefined();
});

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
  register(plugin);
  const result = await resolveExec({ to: groupTopic, threadId: 47 });
  expect(result).toMatchObject({ channel: "none", reason: "exec-route-conflict" });
});

it.each([
  ["scoped plain private chat", "telegram:123456789", "123456789:42", true],
  ["cross scoped chat", privateTopic, "987654321:42", false],
  ["cross scoped topic", privateTopic, "123456789:99", false],
  ["cross scoped channel-DM topic", privateTopic, "123456789:direct-topic:42", false],
] as const)("retains real-plugin authority for %s", async (_label, to, threadId, allowed) => {
  const result = await resolveExec({ to, threadId });
  if (allowed) {
    expectRoute(result, { to: privateTopic, threadId: 42, chatType: "direct" });
  } else {
    // Scoped tuple disagreement is rejected before target refinement.
    expect(result).toMatchObject({ channel: "none", reason: "no-route" });
  }
});

it("preserves verified uppercase Direct Messages scope through the real final resolver", async () => {
  const result = await resolveExec({
    to: "-100155462274",
    threadId: "-100155462274:DIRECT-TOPIC:42",
  });
  expectRoute(result, { to: "telegram:-100155462274:direct-topic:42", threadId: 42 });
});

it.each(["target throws", "target rejects"] as const)(
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
    } else {
      messaging.targetResolver = { looksLikeId: () => false };
      plugin.directory = {
        listGroups: async () => [
          { kind: "group", id: "-1003774691294:topic:47", name: "first" },
          { kind: "group", id: "-1003774691294:topic:47", name: "second" },
        ],
      };
    }
    register(plugin);
    const result = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg,
      agentId: "main",
      heartbeat: { target: "telegram", to: groupTopic, accountId: "work" },
    });
    expectRoute(result, { to: groupTopic });
  },
);
