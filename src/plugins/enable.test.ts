import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { enablePluginInConfig } from "./enable.js";

function expectEnableResult(
  cfg: OpenClawConfig,
  pluginId: string,
  params: {
    enabled: boolean;
    assert: (result: ReturnType<typeof enablePluginInConfig>) => void;
  },
) {
  const result = enablePluginInConfig(cfg, pluginId);
  expect(result.enabled).toBe(params.enabled);
  params.assert(result);
}

function expectEnabledAllowlist(
  result: ReturnType<typeof enablePluginInConfig>,
  expected: string[],
) {
  expect(result.config.plugins?.allow).toEqual(expected);
}

function expectBuiltInChannelEnabled(result: ReturnType<typeof enablePluginInConfig>) {
  expect(result.config.channels?.telegram?.enabled).toBe(true);
  expect(result.config.plugins?.entries?.telegram?.enabled).toBe(true);
}

function expectBuiltInChannelEnabledWithAllowlist(
  result: ReturnType<typeof enablePluginInConfig>,
  expectedAllowlist?: string[],
) {
  expectBuiltInChannelEnabled(result);
  if (expectedAllowlist) {
    expectEnabledAllowlist(result, expectedAllowlist);
  }
}

describe("enablePluginInConfig", () => {
  it.each([
    {
      name: "enables a plugin entry",
      cfg: {} as OpenClawConfig,
      pluginId: "google",
      expectedEnabled: true,
      assert: (result: ReturnType<typeof enablePluginInConfig>) => {
        expect(result.config.plugins?.entries?.google?.enabled).toBe(true);
      },
    },
    {
      name: "adds plugin to allowlist when allowlist is configured",
      cfg: {
        plugins: {
          allow: ["memory-core"],
        },
      } as OpenClawConfig,
      pluginId: "google",
      expectedEnabled: true,
      assert: (result: ReturnType<typeof enablePluginInConfig>) => {
        expectEnabledAllowlist(result, ["memory-core", "google"]);
      },
    },
    {
      name: "refuses enable when plugin is denylisted",
      cfg: {
        plugins: {
          deny: ["google"],
        },
      } as OpenClawConfig,
      pluginId: "google",
      expectedEnabled: false,
      assert: (result: ReturnType<typeof enablePluginInConfig>) => {
        expect(result.reason).toBe("blocked by denylist");
      },
    },
    {
      name: "writes built-in channels to channels.<id>.enabled and plugins.entries",
      cfg: {} as OpenClawConfig,
      pluginId: "telegram",
      expectedEnabled: true,
      assert: expectBuiltInChannelEnabled,
    },
    {
      name: "adds built-in channel id to allowlist when allowlist is configured",
      cfg: {
        plugins: {
          allow: ["memory-core"],
        },
      } as OpenClawConfig,
      pluginId: "telegram",
      expectedEnabled: true,
      assert: (result: ReturnType<typeof enablePluginInConfig>) => {
        expectBuiltInChannelEnabledWithAllowlist(result, ["memory-core", "telegram"]);
      },
    },
    {
      name: "re-enables built-in channels after explicit plugin-level disable",
      cfg: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          entries: {
            telegram: {
              enabled: false,
            },
          },
        },
      } as OpenClawConfig,
      pluginId: "telegram",
      expectedEnabled: true,
      assert: expectBuiltInChannelEnabledWithAllowlist,
    },
  ])("$name", ({ cfg, pluginId, expectedEnabled, assert }) => {
    expectEnableResult(cfg, pluginId, {
      enabled: expectedEnabled,
      assert,
    });
  });
});
