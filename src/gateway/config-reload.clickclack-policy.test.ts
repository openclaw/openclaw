import { afterEach, beforeEach, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "./config-reload-plan.js";

const { clickClackSetupPlugin } = await loadBundledPluginFacade<{
  clickClackSetupPlugin: ChannelPlugin;
}>({
  pluginId: "clickclack",
  artifactBasename: "setup-plugin-api",
});
beforeEach(() =>
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "clickclack", plugin: clickClackSetupPlugin, source: "bundled" },
    ]),
  ),
);
afterEach(() => resetPluginRuntimeStateForTest());

function plan(previous: OpenClawConfig, next: OpenClawConfig) {
  return buildGatewayReloadPlan(
    diffGatewayReloadPaths(previous, next, listConfigReloadRefinementPrefixes()),
  );
}

it.each([false, true])("retains the monitor for allowFrom edits (named=%s)", (named) => {
  const config = (allowFrom: string[]): OpenClawConfig => ({
    channels: {
      clickclack: named ? { accounts: { support: { allowFrom } } } : { allowFrom },
    },
  });
  const result = plan(config(["usr_owner"]), config([]));
  expect(isNoopGatewayReloadPlan(result)).toBe(true);
  expect(result.restartChannels.size).toBe(0);
  expect(result.restartChannelAccounts).toEqual(new Map());
});

it("retains inherited sender policy while keeping an account override", () => {
  const config = (allowFrom: string[]): OpenClawConfig => ({
    channels: { clickclack: { allowFrom, accounts: { support: {}, private: { allowFrom: [] } } } },
  });
  expect(isNoopGatewayReloadPlan(plan(config(["usr_owner"]), config([])))).toBe(true);
});

it.each(["baseUrl", "token", "workspace"])(
  "still replaces the transport when %s changes alongside sender policy",
  (field) => {
    const transport = {
      baseUrl: "https://before.example",
      token: "synthetic-before-token",
      workspace: "wsp_before",
      allowFrom: ["usr_owner"],
    };
    const previous: OpenClawConfig = {
      channels: { clickclack: transport },
    };
    const next: OpenClawConfig = {
      channels: {
        clickclack: { ...transport, [field]: "synthetic-after", allowFrom: [] },
      },
    };
    expect(plan(previous, next).restartChannels).toEqual(new Set(["clickclack"]));
  },
);

it("keeps shared access-group changes owned by channel replacement", () => {
  expect(
    plan(
      {
        accessGroups: {
          responders: { type: "message.senders", members: { clickclack: ["usr_owner"] } },
        },
      },
      { accessGroups: { responders: { type: "message.senders", members: { clickclack: [] } } } },
    ).restartChannels,
  ).toEqual(new Set(["clickclack"]));
});
