import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { enableExplicitlySelectedPluginInConfig, enablePluginInConfig } from "./enable.js";

const enabledEntry = { enabled: true };
const telegramEnabled = {
  channels: { telegram: enabledEntry },
  plugins: { entries: { telegram: enabledEntry } },
};
describe("enablePluginInConfig", () => {
  it.each([
    [
      "enables a canonical plugin allowed through a mixed-case compatibility id",
      "google",
      { plugins: { allow: [" GOOGLE-GEMINI-CLI "] } },
      { plugins: { allow: ["google"], entries: { google: enabledEntry } } },
    ],
    [
      "canonicalizes a mixed-case compatibility target before enabling it",
      " GOOGLE-GEMINI-CLI ",
      {},
      { plugins: { entries: { google: enabledEntry } } },
    ],
    [
      "enables built-in channel already present in configured allowlist",
      "telegram",
      { plugins: { allow: ["telegram"] } },
      { ...telegramEnabled, plugins: { ...telegramEnabled.plugins, allow: ["telegram"] } },
    ],
    [
      "re-enables built-in channels after explicit plugin-level disable",
      "telegram",
      {
        channels: { telegram: enabledEntry },
        plugins: { entries: { telegram: { enabled: false } } },
      },
      telegramEnabled,
    ],
  ] satisfies Array<[string, string, OpenClawConfig, OpenClawConfig]>)(
    "%s",
    (_name, pluginId, cfg, config) => {
      expect(enablePluginInConfig(cfg, pluginId)).toEqual({
        enabled: true,
        pluginId: pluginId === "telegram" ? "telegram" : "google",
        config,
      });
    },
  );

  it("can enable a built-in channel plugin entry without mutating channel config", () => {
    expect(enablePluginInConfig({}, "twitch", { updateChannelConfig: false })).toEqual({
      enabled: true,
      pluginId: "twitch",
      config: { plugins: { entries: { twitch: enabledEntry } } },
    });
  });
});

describe("enableExplicitlySelectedPluginInConfig", () => {
  it("appends ClickClack to a restrictive allowlist before enabling it", () => {
    expect(
      enableExplicitlySelectedPluginInConfig({ plugins: { allow: ["memory-core"] } }, "clickclack"),
    ).toEqual({
      enabled: true,
      pluginId: "clickclack",
      config: {
        plugins: { allow: ["memory-core", "clickclack"], entries: { clickclack: enabledEntry } },
        channels: { clickclack: enabledEntry },
      },
    });
  });
});

const enablers = {
  policy: enablePluginInConfig,
  selection: enableExplicitlySelectedPluginInConfig,
};
it.each([
  ["policy", "google", { deny: [" GOOGLE-GEMINI-CLI "] }, "denylist"],
  ["policy", "telegram", { allow: ["memory-core"] }, "allowlist"],
  ["selection", "google", { allow: ["memory-core"] }, "allowlist"],
  ["selection", "clickclack", { allow: ["memory-core"], deny: ["clickclack"] }, "denylist"],
] satisfies Array<[keyof typeof enablers, string, OpenClawConfig["plugins"], string]>)(
  "%s keeps %s blocked without changing config",
  (entry, pluginId, plugins, policy) => {
    const config = { plugins };
    expect(enablers[entry](config, pluginId)).toEqual({
      config,
      enabled: false,
      pluginId,
      reason: `blocked by ${policy}`,
    });
  },
);
