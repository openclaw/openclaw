// Covers manifest tool-availability gating: config signals, auth signals, and env fallbacks.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import {
  hasManifestToolAvailability,
  hasNonEmptyManifestEnvCandidate,
  manifestConfigSignalPasses,
  manifestPluginSetupProviderEnvVars,
  manifestProviderBaseUrlGuardPasses,
} from "./manifest-tool-availability.js";

function makePlugin(overrides: Partial<PluginManifestRecord>): PluginManifestRecord {
  return {
    id: "demo",
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: "/tmp/demo",
    source: "/tmp/demo/index.js",
    manifestPath: "/tmp/demo/openclaw.plugin.json",
    ...overrides,
  };
}

function makeConfig(value: Record<string, unknown>): OpenClawConfig {
  return value as OpenClawConfig;
}

const webSearchSignal = {
  rootPath: "plugins.entries.xai.config",
  overlayPath: "webSearch",
  required: ["apiKey"],
};

function xaiConfig(config: Record<string, unknown>): OpenClawConfig {
  return makeConfig({ plugins: { entries: { xai: { config } } } });
}

describe("manifestConfigSignalPasses", () => {
  it("fails when the signal root path is absent from config", () => {
    expect(
      manifestConfigSignalPasses({ config: makeConfig({}), env: {}, signal: webSearchSignal }),
    ).toBe(false);
  });

  it("passes when a required path is configured under the overlay", () => {
    expect(
      manifestConfigSignalPasses({
        config: xaiConfig({ webSearch: { apiKey: "sk-xai" } }),
        env: {},
        signal: webSearchSignal,
      }),
    ).toBe(true);
  });

  it("lets overlay values override root values", () => {
    // The overlay merge ({ ...root, ...overlay }) must win over the root value;
    // here the root apiKey is blank and only the overlay provides a real one.
    expect(
      manifestConfigSignalPasses({
        config: xaiConfig({ apiKey: "", webSearch: { apiKey: "sk-xai" } }),
        env: {},
        signal: webSearchSignal,
      }),
    ).toBe(true);
    expect(
      manifestConfigSignalPasses({
        config: xaiConfig({ apiKey: "sk-root", webSearch: { apiKey: "" } }),
        env: {},
        signal: webSearchSignal,
      }),
    ).toBe(false);
  });

  const emptyRequiredValues: Array<[string, unknown]> = [
    ["empty string", ""],
    ["whitespace string", "   "],
    ["empty array", []],
    ["empty object", {}],
    ["null", null],
    ["undefined", undefined],
  ];
  it.each(emptyRequiredValues)("treats %s as not configured", (_label, value) => {
    expect(
      manifestConfigSignalPasses({
        config: xaiConfig({ webSearch: { apiKey: value } }),
        env: {},
        signal: webSearchSignal,
      }),
    ).toBe(false);
  });

  const presentRequiredValues: Array<[string, unknown]> = [
    ["zero", 0],
    ["false", false],
    ["non-empty array", ["a"]],
    ["non-empty object", { nested: true }],
  ];
  it.each(presentRequiredValues)("treats %s as configured", (_label, value) => {
    expect(
      manifestConfigSignalPasses({
        config: xaiConfig({ webSearch: { apiKey: value } }),
        env: {},
        signal: webSearchSignal,
      }),
    ).toBe(true);
  });

  it("resolves env secret refs in required paths against the environment", () => {
    const config = xaiConfig({
      webSearch: { apiKey: { source: "env", id: "XAI_API_KEY" } },
    });
    expect(
      manifestConfigSignalPasses({
        config,
        env: { XAI_API_KEY: "sk-xai" },
        signal: webSearchSignal,
      }),
    ).toBe(true);
    expect(manifestConfigSignalPasses({ config, env: {}, signal: webSearchSignal })).toBe(false);
    expect(
      manifestConfigSignalPasses({
        config,
        env: { XAI_API_KEY: "   " },
        signal: webSearchSignal,
      }),
    ).toBe(false);
  });

  it("passes requiredAny when at least one path is configured", () => {
    const signal = {
      rootPath: "channels.demo",
      requiredAny: ["token", "tokenFile"],
    };
    expect(
      manifestConfigSignalPasses({
        config: makeConfig({ channels: { demo: { tokenFile: "/tmp/token" } } }),
        env: {},
        signal,
      }),
    ).toBe(true);
    expect(
      manifestConfigSignalPasses({
        config: makeConfig({ channels: { demo: { other: true } } }),
        env: {},
        signal,
      }),
    ).toBe(false);
  });

  it("gates on mode allowed/disallowed lists with the declared default", () => {
    const signal = {
      rootPath: "channels.demo",
      mode: { default: "poll", allowed: ["poll", "webhook"] },
    };
    // Missing mode falls back to the default and passes the allowed list.
    expect(
      manifestConfigSignalPasses({
        config: makeConfig({ channels: { demo: {} } }),
        env: {},
        signal,
      }),
    ).toBe(true);
    expect(
      manifestConfigSignalPasses({
        config: makeConfig({ channels: { demo: { mode: "off" } } }),
        env: {},
        signal,
      }),
    ).toBe(false);
    expect(
      manifestConfigSignalPasses({
        config: makeConfig({ channels: { demo: { mode: "webhook" } } }),
        env: {},
        signal: { rootPath: "channels.demo", mode: { disallowed: ["webhook"] } },
      }),
    ).toBe(false);
    // No mode value and no default fails closed.
    expect(
      manifestConfigSignalPasses({
        config: makeConfig({ channels: { demo: {} } }),
        env: {},
        signal: { rootPath: "channels.demo", mode: {} },
      }),
    ).toBe(false);
  });

  it("passes when any overlay-map account satisfies the signal", () => {
    const signal = {
      rootPath: "channels.demo",
      overlayMapPath: "accounts",
      required: ["token"],
    };
    expect(
      manifestConfigSignalPasses({
        config: makeConfig({
          channels: { demo: { accounts: { first: {}, second: { token: "abc" } } } },
        }),
        env: {},
        signal,
      }),
    ).toBe(true);
    expect(
      manifestConfigSignalPasses({
        config: makeConfig({ channels: { demo: { token: "abc" } } }),
        env: {},
        signal,
      }),
    ).toBe(false);
  });
});

describe("manifestProviderBaseUrlGuardPasses", () => {
  const guard = {
    provider: "xai",
    defaultBaseUrl: "https://api.x.ai/v1",
    allowedBaseUrls: ["https://api.x.ai/v1"],
  };

  it("passes when no guard is declared", () => {
    expect(manifestProviderBaseUrlGuardPasses({ config: makeConfig({}), guard: undefined })).toBe(
      true,
    );
  });

  it("falls back to the default base URL when the provider has none configured", () => {
    expect(manifestProviderBaseUrlGuardPasses({ config: makeConfig({}), guard })).toBe(true);
  });

  it("ignores trailing slashes when comparing configured base URLs", () => {
    expect(
      manifestProviderBaseUrlGuardPasses({
        config: makeConfig({
          models: { providers: { xai: { baseUrl: "https://api.x.ai/v1//" } } },
        }),
        guard,
      }),
    ).toBe(true);
  });

  it("fails for a configured base URL outside the allowlist", () => {
    expect(
      manifestProviderBaseUrlGuardPasses({
        config: makeConfig({
          models: { providers: { xai: { baseUrl: "https://proxy.example.com/v1" } } },
        }),
        guard,
      }),
    ).toBe(false);
  });

  it("fails when neither a configured nor a default base URL exists", () => {
    expect(
      manifestProviderBaseUrlGuardPasses({
        config: makeConfig({}),
        guard: { provider: "xai", allowedBaseUrls: ["https://api.x.ai/v1"] },
      }),
    ).toBe(false);
  });
});

describe("manifestPluginSetupProviderEnvVars", () => {
  it("prefers setup provider env vars and falls back to providerAuthEnvVars", () => {
    const plugin = makePlugin({
      providerAuthEnvVars: { xai: ["XAI_API_KEY"] },
      setup: { providers: [{ id: "xai", envVars: ["XAI_TOKEN"] }] },
    });
    expect(manifestPluginSetupProviderEnvVars(plugin, "xai")).toEqual(["XAI_TOKEN"]);

    const fallbackPlugin = makePlugin({ providerAuthEnvVars: { xai: ["XAI_API_KEY"] } });
    expect(manifestPluginSetupProviderEnvVars(fallbackPlugin, "xai")).toEqual(["XAI_API_KEY"]);
    expect(manifestPluginSetupProviderEnvVars(fallbackPlugin, "other")).toEqual([]);
  });
});

describe("hasNonEmptyManifestEnvCandidate", () => {
  const cases: Array<[NodeJS.ProcessEnv, readonly string[], boolean]> = [
    [{ XAI_API_KEY: "sk" }, ["XAI_API_KEY"], true],
    [{ XAI_API_KEY: "   " }, ["XAI_API_KEY"], false],
    [{}, ["XAI_API_KEY"], false],
    [{ OTHER: "x" }, [" ", ""], false],
    [{ SECOND: "ok" }, ["FIRST", "SECOND"], true],
  ];
  it.each(cases)("env %o with vars %o resolves to %s", (env, envVars, expected) => {
    expect(hasNonEmptyManifestEnvCandidate(env, envVars)).toBe(expected);
  });
});

describe("hasManifestToolAvailability", () => {
  const xaiPlugin = makePlugin({
    id: "xai",
    providers: ["xai"],
    providerAuthEnvVars: { xai: ["XAI_API_KEY"] },
    toolMetadata: {
      x_search: {
        authSignals: [{ provider: "xai" }],
        configSignals: [webSearchSignal],
      },
    },
  });

  it("treats tools without manifest metadata as available", () => {
    // Fail-open contract: only tools that declare signals are gated; unknown
    // or unannotated tools must not be hidden by the manifest layer.
    expect(
      hasManifestToolAvailability({ plugin: xaiPlugin, toolNames: ["unlisted"], env: {} }),
    ).toBe(true);
    expect(
      hasManifestToolAvailability({
        plugin: makePlugin({ toolMetadata: { listed: {} } }),
        toolNames: ["listed"],
        env: {},
      }),
    ).toBe(true);
  });

  it("passes on a satisfied config signal without any auth", () => {
    expect(
      hasManifestToolAvailability({
        plugin: xaiPlugin,
        toolNames: ["x_search"],
        config: xaiConfig({ webSearch: { apiKey: "sk-xai" } }),
        env: {},
      }),
    ).toBe(true);
  });

  it("passes when the auth callback grants the signal provider", () => {
    expect(
      hasManifestToolAvailability({
        plugin: xaiPlugin,
        toolNames: ["x_search"],
        env: {},
        hasAuthForProvider: (providerId) => providerId === "xai",
      }),
    ).toBe(true);
  });

  it("passes when a manifest-declared env candidate is present", () => {
    expect(
      hasManifestToolAvailability({
        plugin: xaiPlugin,
        toolNames: ["x_search"],
        env: { XAI_API_KEY: "sk-xai" },
      }),
    ).toBe(true);
  });

  it("fails when config, auth, and env signals are all unsatisfied", () => {
    expect(
      hasManifestToolAvailability({ plugin: xaiPlugin, toolNames: ["x_search"], env: {} }),
    ).toBe(false);
  });

  it("skips auth signals whose provider base URL guard rejects the config", () => {
    const guardedPlugin = makePlugin({
      id: "xai",
      providers: ["xai"],
      toolMetadata: {
        x_search: {
          authSignals: [
            {
              provider: "xai",
              providerBaseUrl: {
                provider: "xai",
                defaultBaseUrl: "https://api.x.ai/v1",
                allowedBaseUrls: ["https://api.x.ai/v1"],
              },
            },
          ],
        },
      },
    });
    const offAllowlist = makeConfig({
      models: { providers: { xai: { baseUrl: "https://proxy.example.com/v1" } } },
    });
    // The guard must veto the auth signal even though auth itself would pass.
    expect(
      hasManifestToolAvailability({
        plugin: guardedPlugin,
        toolNames: ["x_search"],
        config: offAllowlist,
        env: {},
        hasAuthForProvider: () => true,
      }),
    ).toBe(false);
    expect(
      hasManifestToolAvailability({
        plugin: guardedPlugin,
        toolNames: ["x_search"],
        env: {},
        hasAuthForProvider: () => true,
      }),
    ).toBe(true);
  });

  it("maps legacy authProviders and aliases shorthand to auth signals", () => {
    const legacyPlugin = makePlugin({
      id: "legacy",
      providerAuthEnvVars: { alias: ["ALIAS_KEY"] },
      toolMetadata: {
        legacy_tool: { authProviders: ["primary"], aliases: ["alias"] },
      },
    });
    expect(
      hasManifestToolAvailability({
        plugin: legacyPlugin,
        toolNames: ["legacy_tool"],
        env: {},
        hasAuthForProvider: (providerId) => providerId === "primary",
      }),
    ).toBe(true);
    expect(
      hasManifestToolAvailability({
        plugin: legacyPlugin,
        toolNames: ["legacy_tool"],
        env: { ALIAS_KEY: "tok" },
      }),
    ).toBe(true);
    expect(
      hasManifestToolAvailability({ plugin: legacyPlugin, toolNames: ["legacy_tool"], env: {} }),
    ).toBe(false);
  });

  it("passes when any one of several requested tools is available", () => {
    expect(
      hasManifestToolAvailability({
        plugin: xaiPlugin,
        toolNames: ["x_search", "unlisted"],
        env: {},
      }),
    ).toBe(true);
    expect(
      hasManifestToolAvailability({
        plugin: xaiPlugin,
        toolNames: ["x_search", "x_search"],
        env: {},
      }),
    ).toBe(false);
  });
});
