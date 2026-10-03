// Slack plugin reviewer policy changes restart the registered Slack channel.
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "./config-reload-plan.js";

describe("Slack plugin reviewer config reload", () => {
  afterEach(() => setActivePluginRegistry(createTestRegistry([])));

  it.each([
    ["added", undefined, "team:T123:user:U111"],
    ["edited", "team:T123:user:U111", "team:T123:user:U222"],
    ["removed", "team:T123:user:U111", undefined],
  ] as const)("restarts Slack when plugin approvers are %s", async (_change, before, after) => {
    const { slackSetupPlugin } = await loadBundledPluginFacade<{
      slackSetupPlugin: ChannelPlugin;
    }>({
      pluginId: "slack",
      artifactBasename: "setup-plugin-api.ts",
    });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", plugin: slackSetupPlugin, source: "test" }]),
    );
    const configWithApprover = (approver?: string): OpenClawConfig =>
      approver ? { approvals: { plugin: { slack: { approvers: [approver] } } } } : {};
    const changedPaths = diffGatewayReloadPaths(
      configWithApprover(before),
      configWithApprover(after),
      listConfigReloadRefinementPrefixes(),
    );

    const plan = buildGatewayReloadPlan(changedPaths);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartChannels).toEqual(new Set(["slack"]));
    expect(plan.restartChannelAccounts).toEqual(new Map());
    expect(plan.reloadPlugins).toBe(false);
  });
});
