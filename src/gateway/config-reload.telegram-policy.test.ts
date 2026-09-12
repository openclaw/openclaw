import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "./config-reload-plan.js";

const { telegramSetupPlugin } = loadPluginPublicArtifactModuleSync<{
  telegramSetupPlugin: ChannelPlugin;
}>({
  pluginRoot: fileURLToPath(new URL("../../extensions/telegram", import.meta.url)),
  artifactBasename: "setup-plugin-api",
  origin: "bundled",
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

  it.each([true, false])("refreshes account creation/removal (add: %s)", (add) => {
    const empty = { channels: { telegram: { accounts: {} } } };
    const configured = {
      channels: { telegram: { accounts: { support: { dmPolicy: "disabled" as const } } } },
    };
    const plan = planTelegramChange(add ? empty : configured, add ? configured : empty);
    expect(plan.restartChannels).toEqual(new Set(["telegram"]));
  });
});
