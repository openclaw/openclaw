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
    {
      name: "enables a canonical plugin allowed through a mixed-case compatibility id",
      cfg: { plugins: { allow: [" GOOGLE-GEMINI-CLI "] } },
      pluginId: "google",
      config: { plugins: { allow: ["google"], entries: { google: enabledEntry } } },
    },
    {
      name: "canonicalizes a mixed-case compatibility target before enabling it",
      cfg: {},
      pluginId: " GOOGLE-GEMINI-CLI ",
      config: { plugins: { entries: { google: enabledEntry } } },
    },
    {
      name: "enables built-in channel already present in configured allowlist",
      cfg: { plugins: { allow: ["telegram"] } },
      pluginId: "telegram",
      config: { ...telegramEnabled, plugins: { ...telegramEnabled.plugins, allow: ["telegram"] } },
    },
    {
      name: "re-enables built-in channels after explicit plugin-level disable",
      cfg: {
        channels: { telegram: enabledEntry },
        plugins: { entries: { telegram: { enabled: false } } },
      },
      pluginId: "telegram",
      config: telegramEnabled,
    },
  ] satisfies Array<{
    name: string;
    cfg: OpenClawConfig;
    pluginId: string;
    config: OpenClawConfig;
  }>)("$name", ({ cfg, pluginId, config }) => {
    expect(enablePluginInConfig(cfg, pluginId)).toEqual({
      enabled: true,
      pluginId: pluginId === "telegram" ? "telegram" : "google",
      config,
    });
  });

  it.each([
    {
      name: "refuses a canonical plugin denied through a mixed-case compatibility id",
      cfg: { plugins: { deny: [" GOOGLE-GEMINI-CLI "] } },
      pluginId: "google",
      reason: "blocked by denylist",
    },
    {
      name: "refuses built-in channel outside configured allowlist",
      cfg: { plugins: { allow: ["memory-core"] } },
      pluginId: "telegram",
      reason: "blocked by allowlist",
    },
  ])("$name", ({ cfg, pluginId, reason }) => {
    expect(enablePluginInConfig(cfg, pluginId)).toEqual({
      config: cfg,
      enabled: false,
      pluginId,
      reason,
    });
  });

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

  it.each([
    { pluginId: "google", plugins: { allow: ["memory-core"] }, reason: "blocked by allowlist" },
    {
      pluginId: "clickclack",
      plugins: { allow: ["memory-core"], deny: ["clickclack"] },
      reason: "blocked by denylist",
    },
  ])(
    "keeps $pluginId blocked by policy without changing the allowlist",
    ({ pluginId, plugins, reason }) => {
      const config = { plugins };
      expect(enableExplicitlySelectedPluginInConfig(config, pluginId)).toEqual({
        config,
        enabled: false,
        pluginId,
        reason,
      });
    },
  );
});
