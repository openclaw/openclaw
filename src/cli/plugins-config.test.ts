import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setPluginEnabledInConfig } from "../plugins/toggle-config.js";

describe("setPluginEnabledInConfig", () => {
  it.each([
    {
      name: "ordered duplicates",
      policy: {
        allow: [" GOOGLE-GEMINI-CLI ", "alpha", "google", " "],
        deny: [" omega ", "OMEGA", ""],
      },
      expected: { allow: ["google", "alpha", "google"], deny: ["omega", "omega"] },
    },
  ])("preserves raw siblings and $name policy properties", ({ policy, expected }) => {
    const alpha = { enabled: false, custom: "kept", llm: { allowedModels: [" model "] } };
    const omega = { config: { optional: undefined, nested: { kept: true } } };
    const targetModels = ["target-model"];
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          alpha,
          "GOOGLE-GEMINI-CLI": { config: { models: targetModels } },
          omega,
        },
        ...policy,
      },
    };
    const before = structuredClone(config);

    const next = setPluginEnabledInConfig(config, "google", false);

    expect(config).toStrictEqual(before);
    expect(Object.keys(next.plugins ?? {})).toEqual(Object.keys(config.plugins ?? {}));
    expect(Object.keys(next.plugins?.entries ?? {})).toEqual(["alpha", "omega", "google"]);
    expect(next.plugins?.entries?.alpha).toBe(alpha);
    expect(next.plugins?.entries?.omega).toBe(omega);
    expect(next.plugins?.entries?.google).toEqual({
      config: { models: targetModels },
      enabled: false,
    });
    for (const key of ["allow", "deny"] as const) {
      expect(Object.hasOwn(next.plugins ?? {}, key)).toBe(Object.hasOwn(policy, key));
      expect(next.plugins?.[key]).toEqual(expected[key]);
      if (Array.isArray(policy[key])) {
        expect(Object.is(next.plugins?.[key], policy[key])).toBe(false);
      }
    }
  });

  const legacyEntry = {
    config: { region: "us", nested: { legacy: true, shared: "legacy" } },
    custom: "legacy",
    enabled: true,
  };
  const canonicalEntry = {
    config: { model: "gemini", nested: { canonical: true, shared: "canonical" } },
    custom: "canonical",
    enabled: false,
  };
  it.each([
    {
      name: "canonical entry first",
      entries: { google: canonicalEntry, "GOOGLE-GEMINI-CLI": legacyEntry },
    },
  ])("deep-merges compatibility settings with $name", ({ entries }) => {
    const config = {
      plugins: {
        entries,
      },
    } as OpenClawConfig;

    const next = setPluginEnabledInConfig(config, "google", true);

    expect(next.plugins?.entries).toEqual({
      google: {
        config: {
          model: "gemini",
          nested: {
            canonical: true,
            legacy: true,
            shared: "canonical",
          },
          region: "us",
        },
        custom: "canonical",
        enabled: true,
      },
    });
  });

  it("keeps built-in channel and plugin entry flags in sync", () => {
    const config = {
      channels: {
        telegram: {
          enabled: true,
          dmPolicy: "open",
        },
      },
      plugins: {
        entries: {
          telegram: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    const disabled = setPluginEnabledInConfig(config, "telegram", false);
    expect(disabled.channels?.telegram).toEqual({
      enabled: false,
      dmPolicy: "open",
    });
    expect(disabled.plugins?.entries?.telegram).toEqual({
      enabled: false,
    });

    const reenabled = setPluginEnabledInConfig(disabled, "telegram", true);
    expect(reenabled.channels?.telegram).toEqual({
      enabled: true,
      dmPolicy: "open",
    });
    expect(reenabled.plugins?.entries?.telegram).toEqual({
      enabled: true,
    });

    const pluginOnly = setPluginEnabledInConfig(config, "telegram", false, {
      updateChannelConfig: false,
    });
    expect(pluginOnly.channels).toBe(config.channels);
    expect(pluginOnly.plugins?.entries?.telegram?.enabled).toBe(false);
    expect(config.channels?.telegram?.enabled).toBe(true);
  });
});
