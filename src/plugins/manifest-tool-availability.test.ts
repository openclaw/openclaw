// Manifest tool-availability tests cover config, auth, environment, and base-URL gates.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import {
  hasManifestToolAvailability,
  manifestConfigSignalPasses,
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

describe("hasManifestToolAvailability", () => {
  it.each([
    [
      "selected store default shadowing exec",
      secretRef("store"),
      {
        defaults: { store: "shared" },
        providers: { shared: { source: "exec", command: "/tmp/unused-store-alias-command" } },
      },
      true,
    ],
    [
      "explicit matching store provider",
      secretRef("store"),
      { providers: { shared: { source: "store" } } },
      true,
    ],
    ["missing non-default store provider", secretRef("store"), undefined, false],
    [
      "mismatched non-default store provider",
      secretRef("store"),
      { providers: { shared: { source: "file", path: "/tmp/unused.json" } } },
      false,
    ],
    [
      "old store default after selecting another alias",
      secretRef("store", "default"),
      { defaults: { store: "shared" } },
      false,
    ],
    ["undeclared file default", secretRef("file", "default"), undefined, false],
  ] satisfies Array<readonly [string, SecretRef, OpenClawConfig["secrets"], boolean]>)(
    "checks %s through config-only metadata",
    (_name, ref, secrets, expected) => {
      const plugin = makePlugin({
        toolMetadata: { x_search: { configSignals: [webSearchSignal] } },
      });
      const config: OpenClawConfig = {
        ...xaiConfig({ webSearch: { apiKey: ref } }),
        secrets,
      };
      expect(available(plugin, { config })).toBe(expected);
    },
  );

  it("fails open for tools without availability signals", () => {
    const xaiPlugin = makePlugin({
      toolMetadata: { x_search: { authSignals: [{ provider: "xai" }] } },
    });
    expect(available(xaiPlugin, { toolNames: ["unlisted"] })).toBe(true);
    expect(available(makePlugin({ toolMetadata: { listed: {} } }), { toolNames: ["listed"] })).toBe(
      true,
    );
    expect(available(xaiPlugin, { toolNames: ["x_search", "unlisted"] })).toBe(true);
  });

  it.each([
    [guard, "https://proxy.example/v1", false],
    [guard, undefined, true],
    [guard, "https://api.x.ai/v1//", true],
    [{ provider: "xai", allowedBaseUrls: guard.allowedBaseUrls }, undefined, false],
  ] as const)(
    "lets provider base-URL guard %j veto auth at %s",
    (providerBaseUrl, baseUrl, expected) => {
      const plugin = makePlugin({
        toolMetadata: { x_search: { authSignals: [{ provider: "xai", providerBaseUrl }] } },
      });
      const config = makeConfig(baseUrl ? { models: { providers: { xai: { baseUrl } } } } : {});
      expect(available(plugin, { config, hasAuthForProvider: () => true })).toBe(expected);
      expect(available(plugin)).toBe(false);
    },
  );

  it("maps legacy provider and alias shorthand into auth signals", () => {
    const legacyPlugin = makePlugin({
      setup: { providers: [{ id: "alias", envVars: ["MISSING_KEY", "ALIAS_KEY"] }] },
      toolMetadata: { legacy_tool: { authProviders: ["primary"], aliases: ["alias"] } },
    });
    const legacy = (overrides: Parameters<typeof available>[1] = {}) =>
      available(legacyPlugin, { toolNames: ["legacy_tool"], ...overrides });
    expect(legacy({ hasAuthForProvider: (providerId) => providerId === "primary" })).toBe(true);
    expect(legacy({ env: { ALIAS_KEY: "token" } })).toBe(true);
    expect(legacy()).toBe(false);
  });
});
