import { afterEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getStatusSummary } from "../../status/summary.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { hasResolvableHeartbeatOwnerRoute, resolveHeartbeatDeliveryTarget } from "./targets.js";

const registrySnapshot = captureActivePluginRegistrySnapshot();
const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
  pluginId: "telegram",
  artifactBasename: "api.ts",
});
const telegramRegistry = createTestRegistry([
  { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
]);

afterEach(() => restoreActivePluginRegistrySnapshot(registrySnapshot));

describe.each(["active", "scoped"] as const)("heartbeat owner in %s registry", (scope) => {
  it.each([
    { name: "prefixed owner", ownerAllowFrom: ["telegram:1234567890"] },
    { name: "string owner", ownerAllowFrom: ["1234567890"] },
    { name: "numeric owner", ownerAllowFrom: [1234567890] },
    { name: "channel allowFrom", allowFrom: ["1234567890"] },
  ])("resolves $name through the Telegram plugin without session history", async (owner) => {
    const cfg: OpenClawConfig = {
      commands: { ownerAllowFrom: owner.ownerAllowFrom },
      channels: { telegram: { botToken: "test-token", allowFrom: owner.allowFrom } },
    };
    setActivePluginRegistry(scope === "active" ? telegramRegistry : createTestRegistry());
    await withPluginRuntimeRegistryScope(
      scope === "scoped" ? telegramRegistry : undefined,
      async () => {
        expect(await hasResolvableHeartbeatOwnerRoute({ cfg })).toBe(true);
        expect(await resolveHeartbeatDeliveryTarget({ cfg, agentId: "main" })).toMatchObject({
          channel: "telegram",
          to: "telegram:1234567890",
          chatType: "direct",
        });
      },
    );
  });
});

it("reports a scoped Telegram owner's heartbeat ready in the Gateway status summary", async () => {
  await withOpenClawTestState({ prefix: "heartbeat-owner-status-" }, async () => {
    const cfg: OpenClawConfig = {
      commands: { ownerAllowFrom: ["telegram:1234567890"] },
      channels: { telegram: { botToken: "test-token" } },
    };
    setActivePluginRegistry(createTestRegistry());
    await withPluginRuntimeRegistryScope(telegramRegistry, async () => {
      const summary = await getStatusSummary({ config: cfg, includeChannelSummary: false });
      expect(summary.heartbeat.agents).toEqual([
        expect.objectContaining({ agentId: "main", enabled: true, waitingForRoute: false }),
      ]);
    });
  });
});
