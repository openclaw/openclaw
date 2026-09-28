import { afterEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "./config-reload-plan.js";

const { telegramSetupPlugin } = await loadBundledPluginFacade<{
  telegramSetupPlugin: ChannelPlugin;
}>({
  artifactBasename: "setup-plugin-api",
  pluginId: "telegram",
});

function planTelegramChange(prev: OpenClawConfig, next: OpenClawConfig) {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", plugin: telegramSetupPlugin, source: "bundled" }]),
  );
  return buildGatewayReloadPlan(
    diffGatewayReloadPaths(prev, next, listConfigReloadRefinementPrefixes()),
  );
}

afterEach(() => resetPluginRuntimeStateForTest());

describe("Telegram live policy reload", () => {
  it.each([undefined, "support"])("retains the monitor for policy changes in %s", (accountId) => {
    const previous = {
      dmPolicy: "allowlist" as const,
      allowFrom: ["42"],
      groupPolicy: "allowlist" as const,
      groupAllowFrom: ["42"],
      replyToMode: "off" as const,
      streaming: { mode: "off" as const },
      textChunkLimit: 4000,
    };
    const next = {
      dmPolicy: "disabled" as const,
      allowFrom: ["43"],
      groupPolicy: "disabled" as const,
      groupAllowFrom: ["43"],
      replyToMode: "first" as const,
      streaming: { mode: "partial" as const, preview: { toolProgress: false } },
      textChunkLimit: 1000,
    };
    const config = (policy: typeof previous | typeof next): OpenClawConfig => ({
      channels: { telegram: accountId ? { accounts: { [accountId]: policy } } : policy },
    });
    const plan = planTelegramChange(config(previous), config(next));
    expect(plan.changedPaths.length).toBeGreaterThanOrEqual(7);
    expect(isNoopGatewayReloadPlan(plan)).toBe(true);
    expect(plan.restartChannels.size).toBe(0);
  });

  it.each([
    ["botToken", "123456:synthetic-token"],
    ["apiRoot", "https://api.telegram.org"],
    ["proxy", "http://127.0.0.1:8080"],
    ["commands", { native: false }],
    ["customCommands", [{ command: "hello", description: "Say hello" }]],
    ["futurePolicy", true],
  ])("keeps startup ownership for %s even alongside live policy", (key, value) => {
    const plan = planTelegramChange(
      { channels: { telegram: { accounts: { support: { dmPolicy: "disabled" } } } } },
      {
        channels: {
          telegram: {
            accounts: { support: { dmPolicy: "pairing", [key]: value } },
          },
        },
      },
    );
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartChannels).toEqual(new Set(["telegram"]));
  });

  it.each([
    { add: true, decisionAgent: false },
    { add: false, decisionAgent: false },
    { add: true, decisionAgent: true },
    { add: false, decisionAgent: true },
  ])(
    "refreshes account creation/removal (add: $add, decision agent: $decisionAgent)",
    ({ add, decisionAgent }) => {
      const empty: OpenClawConfig = {
        channels: { telegram: { accounts: {} } },
        ...(decisionAgent ? { agents: { entries: {} } } : {}),
      };
      const configured: OpenClawConfig = {
        channels: { telegram: { accounts: { support: { dmPolicy: "disabled" } } } },
        ...(decisionAgent
          ? { agents: { entries: { worker: { decisionModel: "fixture/fast" } } } }
          : {}),
      };
      const plan = planTelegramChange(add ? empty : configured, add ? configured : empty);
      expect(plan.restartChannels).toEqual(new Set(["telegram"]));
      expect(plan.reloadPlugins).toBe(decisionAgent);
    },
  );
});
