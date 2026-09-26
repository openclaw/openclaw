// Covers plugin enablement decisions and disabled-state handling.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { enableExplicitlySelectedPluginInConfig, enablePluginInConfig } from "./enable.js";

function expectBuiltInChannelEnabled(result: ReturnType<typeof enablePluginInConfig>) {
  expect(result.config.channels?.telegram?.enabled).toBe(true);
  expect(result.config.plugins?.entries?.telegram?.enabled).toBe(true);
}

describe("enablePluginInConfig", () => {
  it.each([
    {
      name: "enables a canonical plugin allowed through a mixed-case compatibility id",
      cfg: {
        plugins: {
          allow: [" GOOGLE-GEMINI-CLI "],
        },
      } as OpenClawConfig,
      pluginId: "google",
      expectedEnabled: true,
      assert: (result: ReturnType<typeof enablePluginInConfig>) => {
        expect(result.pluginId).toBe("google");
        expect(result.config.plugins?.entries?.google?.enabled).toBe(true);
        expect(result.config.plugins?.allow).toEqual(["google"]);
      },
    },
    {
      name: "canonicalizes a mixed-case compatibility target before enabling it",
      cfg: {} as OpenClawConfig,
      pluginId: " GOOGLE-GEMINI-CLI ",
      expectedEnabled: true,
      assert: (result: ReturnType<typeof enablePluginInConfig>) => {
        expect(result.pluginId).toBe("google");
        expect(result.config.plugins?.entries?.google?.enabled).toBe(true);
        expect(result.config.plugins?.entries?.[" GOOGLE-GEMINI-CLI "]).toBeUndefined();
      },
    },
    {
      name: "refuses a canonical plugin denied through a mixed-case compatibility id",
      cfg: {
        plugins: {
          deny: [" GOOGLE-GEMINI-CLI "],
        },
      } as OpenClawConfig,
      pluginId: "google",
      expectedEnabled: false,
      assert: (result: ReturnType<typeof enablePluginInConfig>) => {
        expect(result.pluginId).toBe("google");
        expect(result.reason).toBe("blocked by denylist");
        expect(result.config.plugins?.entries?.google).toBeUndefined();
      },
    },
    {
      name: "refuses built-in channel enable when channel is outside configured allowlist",
      cfg: {
        plugins: {
          allow: ["memory-core"],
        },
      } as OpenClawConfig,
      pluginId: "telegram",
      expectedEnabled: false,
      assert: (result: ReturnType<typeof enablePluginInConfig>) => {
        expect(result.reason).toBe("blocked by allowlist");
        expect(result.config.plugins?.allow).toEqual(["memory-core"]);
        expect(result.config.channels?.telegram?.enabled).toBeUndefined();
      },
    },
    {
      name: "enables built-in channel already present in configured allowlist",
      cfg: {
        plugins: {
          allow: ["telegram"],
        },
      } as OpenClawConfig,
      pluginId: "telegram",
      expectedEnabled: true,
      assert: (result: ReturnType<typeof enablePluginInConfig>) => {
        expectBuiltInChannelEnabled(result);
        expect(result.config.plugins?.allow).toEqual(["telegram"]);
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
      assert: expectBuiltInChannelEnabled,
    },
  ])("$name", ({ cfg, pluginId, expectedEnabled, assert }) => {
    const result = enablePluginInConfig(cfg, pluginId);
    expect(result.enabled).toBe(expectedEnabled);
    assert(result);
  });

  it("can enable a built-in channel plugin entry without mutating channel config", () => {
    const result = enablePluginInConfig({} as OpenClawConfig, "twitch", {
      updateChannelConfig: false,
    });

    expect(result.enabled).toBe(true);
    expect(result.config.plugins?.entries?.twitch?.enabled).toBe(true);
    expect(result.config.channels?.twitch).toBeUndefined();
  });
});

describe("enableExplicitlySelectedPluginInConfig", () => {
  it("appends ClickClack to a restrictive allowlist before enabling it", () => {
    const result = enableExplicitlySelectedPluginInConfig(
      {
        plugins: {
          allow: ["memory-core"],
        },
      } as OpenClawConfig,
      "clickclack",
    );

    expect(result.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["memory-core", "clickclack"]);
    expect(result.config.plugins?.entries?.clickclack?.enabled).toBe(true);
    expect(result.config.channels?.clickclack?.enabled).toBe(true);
  });

  it("keeps unrelated explicit plugin enables blocked by a restrictive allowlist", () => {
    const cfg = {
      plugins: {
        allow: ["memory-core"],
      },
    } as OpenClawConfig;

    const result = enableExplicitlySelectedPluginInConfig(cfg, "google");

    expect(result).toEqual({
      config: cfg,
      enabled: false,
      pluginId: "google",
      reason: "blocked by allowlist",
    });
  });

  it("keeps ClickClack blocked by the denylist without changing the allowlist", () => {
    const cfg = {
      plugins: {
        allow: ["memory-core"],
        deny: ["clickclack"],
      },
    } as OpenClawConfig;

    const result = enableExplicitlySelectedPluginInConfig(cfg, "clickclack");

    expect(result).toEqual({
      config: cfg,
      enabled: false,
      pluginId: "clickclack",
      reason: "blocked by denylist",
    });
  });
});
