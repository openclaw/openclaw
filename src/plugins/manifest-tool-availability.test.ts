// Manifest tool-availability tests cover config, auth, environment, and base-URL gates.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
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
const guard = {
  provider: "xai",
  defaultBaseUrl: "https://api.x.ai/v1",
  allowedBaseUrls: ["https://api.x.ai/v1"],
};

function xaiConfig(config: Record<string, unknown>): OpenClawConfig {
  return makeConfig({ plugins: { entries: { xai: { config } } } });
}
function configSignal(config: OpenClawConfig, env: NodeJS.ProcessEnv = {}) {
  return manifestConfigSignalPasses({ config, env, signal: webSearchSignal });
}
function secretRef(source: SecretRef["source"], provider = "shared"): SecretRef {
  return { source, provider, id: source === "file" ? "/tool/apiKey" : "TOOL_API_KEY" };
}
function available(
  plugin: PluginManifestRecord,
  overrides: Partial<Omit<Parameters<typeof hasManifestToolAvailability>[0], "plugin">> = {},
) {
  return hasManifestToolAvailability({ plugin, toolNames: ["x_search"], env: {}, ...overrides });
}

describe("manifestConfigSignalPasses", () => {
  it.each<
    [
      Record<string, unknown>,
      Omit<Parameters<typeof manifestConfigSignalPasses>[0]["signal"], "rootPath">,
      boolean,
    ]
  >([
    [{ tokenFile: "/tmp/token" }, { requiredAny: ["token", "tokenFile"] }, true],
    [{ mode: "off" }, { mode: { allowed: ["poll", "webhook"] } }, false],
    [{ mode: "webhook" }, { mode: { disallowed: ["webhook"] } }, false],
    [{}, { mode: {} }, false],
    [
      { accounts: { first: {}, second: { token: "abc" } } },
      { overlayMapPath: "accounts", required: ["token"] },
      true,
    ],
  ])("handles channel config %j using %j", (demo, signal, expected) => {
    expect(
      manifestConfigSignalPasses({
        config: makeConfig({ channels: { demo } }),
        env: {},
        signal: { rootPath: "channels.demo", ...signal },
      }),
    ).toBe(expected);
  });

  it.each([
    [false, true],
    [["value"], true],
    [{ value: true }, true],
  ] as const)("treats required value %o as configured=%s", (apiKey, expected) => {
    expect(configSignal(xaiConfig({ webSearch: { apiKey } }))).toBe(expected);
  });

  it("resolves env secret refs only when their value is non-empty", () => {
    const config = xaiConfig({
      webSearch: { apiKey: { source: "env", provider: "default", id: "XAI_API_KEY" } },
    });
    expect(configSignal(config, { XAI_API_KEY: "token" })).toBe(true);
    expect(configSignal(config, { XAI_API_KEY: "   " })).toBe(false);
  });

  it.each([
    ["present selected env", true, { COLLISION_KEY: "synthetic-key" }, true],
    ["missing selected env", true, {}, false],
    ["non-default mismatch", false, { COLLISION_KEY: "synthetic-key" }, false],
  ] as const)("evaluates %s under an exec collision", (_name, selected, env, expected) => {
    const config = xaiConfig({
      webSearch: { apiKey: { source: "env", provider: "selected", id: "COLLISION_KEY" } },
    });
    config.secrets = {
      defaults: selected ? { env: "selected" } : undefined,
      providers: { selected: { source: "exec", command: "/unused" } },
    };
    expect(configSignal(config, env)).toBe(expected);
  });

  it.each([
    { allowlist: ["XAI_API_KEY"], expected: true },
    { allowlist: ["OTHER_API_KEY"], expected: false },
  ])("honors the explicit env provider allowlist $allowlist", ({ allowlist, expected }) => {
    const config: OpenClawConfig = {
      ...xaiConfig({
        webSearch: { apiKey: { source: "env", provider: "shared", id: "XAI_API_KEY" } },
      }),
      secrets: { providers: { shared: { source: "env", allowlist } } },
    };
    expect(configSignal(config, { XAI_API_KEY: "token" })).toBe(expected);
  });
});

describe("manifestProviderBaseUrlGuardPasses", () => {
  it.each([
    [undefined, undefined, true],
    [guard, undefined, true],
    [guard, "https://api.x.ai/v1//", true],
    [{ provider: "xai", allowedBaseUrls: guard.allowedBaseUrls }, undefined, false],
  ] as const)("checks guard %j with base URL %s", (selectedGuard, baseUrl, expected) => {
    const config = makeConfig(
      baseUrl === undefined
        ? {}
        : {
            models: { providers: { xai: { baseUrl } } },
          },
    );
    expect(manifestProviderBaseUrlGuardPasses({ config, guard: selectedGuard })).toBe(expected);
  });
});

describe("manifest auth environment helpers", () => {
  it("uses setup provider env vars and returns empty without setup metadata", () => {
    // providerAuthEnvVars is retired; setup provider metadata is the canonical env source.
    const plugin = makePlugin({
      setup: { providers: [{ id: "xai", envVars: ["XAI_API_KEY"] }] },
    });
    expect(manifestPluginSetupProviderEnvVars(plugin, "xai")).toEqual(["XAI_API_KEY"]);
    expect(manifestPluginSetupProviderEnvVars(plugin, "other")).toEqual([]);
    expect(manifestPluginSetupProviderEnvVars(makePlugin({}), "xai")).toEqual([]);
  });

  it("resolves env candidates", () => {
    expect(hasNonEmptyManifestEnvCandidate({ SECOND: "token" }, ["FIRST", "SECOND"])).toBe(true);
  });
});

describe("hasManifestToolAvailability", () => {
  const xaiPlugin = makePlugin({
    id: "xai",
    providers: ["xai"],
    setup: { providers: [{ id: "xai", envVars: ["XAI_API_KEY"] }] },
    toolMetadata: {
      x_search: {
        authSignals: [{ provider: "xai" }],
        configSignals: [webSearchSignal],
      },
    },
  });

  it.each<{
    name: string;
    ref: SecretRef;
    secrets?: OpenClawConfig["secrets"];
    expected: boolean;
  }>([
    {
      name: "selected store default shadowing exec",
      ref: secretRef("store"),
      secrets: {
        defaults: { store: "shared" },
        providers: { shared: { source: "exec", command: "/tmp/unused-store-alias-command" } },
      },
      expected: true,
    },
    ...(
      [
        { source: "store" },
        { source: "file", path: "/tmp/unused-store-alias-fixture.json" },
        { source: "exec", command: "/tmp/unused-store-alias-command" },
      ] as const
    ).map((provider) => ({
      name: `explicit matching non-default ${provider.source} provider`,
      ref: secretRef(provider.source),
      secrets: { providers: { shared: provider } },
      expected: true,
    })),
    {
      name: "missing non-default store provider",
      ref: secretRef("store"),
      expected: false,
    },
    {
      name: "mismatched non-default store provider",
      ref: secretRef("store"),
      secrets: { providers: { shared: { source: "file", path: "/tmp/unused.json" } } },
      expected: false,
    },
    {
      name: "old store default after selecting another alias",
      ref: secretRef("store", "default"),
      secrets: { defaults: { store: "shared" } },
      expected: false,
    },
    ...(["file", "exec"] as const).map((source) => ({
      name: `undeclared ${source} default`,
      ref: secretRef(source, "default"),
      expected: false,
    })),
  ])("checks $name through config-only metadata", ({ ref, secrets, expected }) => {
    const plugin = makePlugin({
      toolMetadata: { x_search: { configSignals: [webSearchSignal] } },
    });
    const config: OpenClawConfig = {
      ...xaiConfig({ webSearch: { apiKey: ref } }),
      secrets,
    };
    expect(available(plugin, { config })).toBe(expected);
  });

  it("fails open for tools without availability signals", () => {
    expect(available(xaiPlugin, { toolNames: ["unlisted"] })).toBe(true);
    expect(available(makePlugin({ toolMetadata: { listed: {} } }), { toolNames: ["listed"] })).toBe(
      true,
    );
    expect(available(xaiPlugin, { toolNames: ["x_search", "unlisted"] })).toBe(true);
  });

  it("lets a provider base-URL guard veto otherwise valid auth", () => {
    const guardedPlugin = makePlugin({
      toolMetadata: {
        x_search: {
          authSignals: [{ provider: "xai", providerBaseUrl: guard }],
        },
      },
    });
    expect(
      available(guardedPlugin, {
        config: makeConfig({
          models: { providers: { xai: { baseUrl: "https://proxy.example/v1" } } },
        }),
        hasAuthForProvider: () => true,
      }),
    ).toBe(false);
    expect(available(guardedPlugin, { hasAuthForProvider: () => true })).toBe(true);
  });

  it("maps legacy provider and alias shorthand into auth signals", () => {
    const legacyPlugin = makePlugin({
      setup: { providers: [{ id: "alias", envVars: ["ALIAS_KEY"] }] },
      toolMetadata: { legacy_tool: { authProviders: ["primary"], aliases: ["alias"] } },
    });
    const legacy = (overrides: Parameters<typeof available>[1] = {}) =>
      available(legacyPlugin, { toolNames: ["legacy_tool"], ...overrides });
    expect(legacy({ hasAuthForProvider: (providerId) => providerId === "primary" })).toBe(true);
    expect(legacy({ env: { ALIAS_KEY: "token" } })).toBe(true);
    expect(legacy()).toBe(false);
  });
});
