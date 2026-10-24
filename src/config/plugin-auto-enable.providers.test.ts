// Covers provider-driven plugin auto-enable decisions.
import { afterAll, describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import {
  makeIsolatedEnv,
  makeRegistry,
  resetPluginAutoEnableTestState,
} from "./plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const env = makeIsolatedEnv();
type ManifestPlugin = Parameters<typeof makeRegistry>[0][number];
function autoEnable(config: OpenClawConfig, plugins?: ManifestPlugin[]) {
  return applyPluginAutoEnable({
    config,
    env,
    ...(plugins ? { manifestRegistry: makeRegistry(plugins) } : {}),
  });
}
function provider(
  id: string,
  contracts: ManifestPlugin["contracts"],
  origin: ManifestPlugin["origin"] = "config",
): ManifestPlugin {
  return { id, channels: [], contracts, origin };
}
const storage = {
  locations: {
    archive: { provider: "archive-objects", settings: {}, encryption: "none" as const },
  },
};

afterAll(() => {
  resetPluginAutoEnableTestState();
});

describe("applyPluginAutoEnable providers", () => {
  it.each<[string, OpenClawConfig, ManifestPlugin["contracts"], string]>([
    [
      "decision-plugin",
      { agents: { defaults: { decisionModel: "judge/fast" } } },
      { decisionProviders: ["judge"] },
      "judge decision provider selected",
    ],
    [
      "qa-lab",
      { cloudWorkers: { profiles: { development: { provider: " STATIC-SSH " } } } },
      { workerProviders: ["static-ssh"] },
      "static-ssh worker provider selected",
    ],
    [
      "storage-fixture",
      {
        storage: {
          locations: { archive: { ...storage.locations.archive, provider: " ARCHIVE-OBJECTS " } },
        },
      },
      { storageProviders: ["archive-objects"] },
      "archive-objects storage provider selected",
    ],
  ])("activates the selected bundled contract owner %s", (id, config, contracts, reason) => {
    const result = autoEnable({ ...config, plugins: { allow: ["telegram"] } }, [
      provider(id, contracts, "bundled"),
    ]);
    expect(result.config.plugins).toMatchObject({
      allow: ["telegram", id],
      entries: { [id]: { enabled: true } },
    });
    expect(result.autoEnabledReasons).toEqual({ [id]: [reason] });
  });

  const googleProviderCases: Array<{ name: string; config: OpenClawConfig }> = [
    {
      name: "Google auth profile",
      config: { auth: { profiles: { "google:default": { provider: "google", mode: "api_key" } } } },
    },
    {
      name: "Google provider config",
      config: {
        models: {
          providers: {
            google: {
              apiKey: "configured-google-key",
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              models: [],
            },
          },
        },
      },
    },
  ];

  it.each(googleProviderCases)(
    "auto-enables the Google plugin from $name under a restrictive allowlist",
    ({ config }) => {
      const result = autoEnable({ ...config, plugins: { allow: ["telegram"] } });

      expect(result.config.plugins?.entries?.google?.enabled).toBe(true);
      expect(result.config.plugins?.allow).toEqual(["telegram", "google"]);
    },
  );

  it("auto-enables selected web search provider plugins under restrictive allowlists", () => {
    const result = autoEnable(
      {
        tools: { web: { search: { provider: "brave" } } },
        plugins: { allow: ["telegram"] },
      },
      [provider("brave", { webSearchProviders: ["brave"] })],
    );

    expect(result.config.plugins?.entries?.brave?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "brave"]);
    expect(result.changes).toContain("brave web search provider selected, enabled automatically.");
  });

  it.each([
    { origin: "global" as const, plugins: {} },
    { origin: "bundled" as const, plugins: { enabled: false } },
    { origin: "bundled" as const, plugins: { deny: ["storage-fixture"] } },
  ])(
    "does not auto-enable storage against external trust or explicit disablement: %j",
    ({ origin, plugins }) => {
      const result = autoEnable({ storage, plugins }, [
        provider("storage-fixture", { storageProviders: ["archive-objects"] }, origin),
      ]);
      expect(result.config.plugins?.entries?.["storage-fixture"]?.enabled).not.toBe(true);
      expect(result.changes).toEqual([]);
    },
  );

  it("requires explicit enablement for external worker providers", () => {
    const result = autoEnable(
      { cloudWorkers: { profiles: { production: { provider: "cloud-vendor" } } } },
      [provider("cloud-vendor-plugin", { workerProviders: ["cloud-vendor"] }, "global")],
    );

    expect(result.config.plugins?.entries?.["cloud-vendor-plugin"]).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  it("does not auto-enable selected web search provider plugins when web search is disabled", () => {
    const result = autoEnable(
      {
        tools: { web: { search: { enabled: false, provider: "brave" } } },
        plugins: { allow: ["telegram"] },
        agents: { defaults: { model: "codex/gpt-5.4" } },
      },
      [
        provider("brave", { webSearchProviders: ["brave"] }),
        { id: "codex", channels: [], providers: ["codex"] },
      ],
    );

    expect(result.config.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.brave).toBeUndefined();
    expect(result.config.plugins?.allow).toEqual(["telegram", "codex"]);
    expect(result.changes).toContain("codex/gpt-5.4 model configured, enabled automatically.");
    expect(result.changes).not.toContain(
      "brave web search provider selected, enabled automatically.",
    );
  });

  it("auto-enables third-party provider plugins when manifest-owned web search config exists", () => {
    const result = autoEnable(
      {
        plugins: { entries: { acme: { config: { webSearch: { apiKey: "acme-search-key" } } } } },
      },
      [{ ...provider("acme", { webSearchProviders: ["acme-search"] }), providers: ["acme-ai"] }],
    );

    expect(result.config.plugins?.entries?.acme?.enabled).toBe(true);
    expect(result.changes).toContain("acme web search configured, enabled automatically.");
  });

  it("auto-enables third-party plugins when manifest-owned tool config exists", () => {
    const result = autoEnable(
      { plugins: { entries: { acme: { config: { acmeTool: { enabled: true } } } } } },
      [
        {
          id: "acme",
          channels: [],
          contracts: { tools: ["acme_tool"] },
          configSchema: {
            type: "object",
            properties: {
              webSearch: { type: "object" },
              acmeTool: { type: "object" },
            },
          },
        },
      ],
    );

    expect(result.config.plugins?.entries?.acme?.enabled).toBe(true);
    expect(result.changes).toContain("acme tool configured, enabled automatically.");
  });

  it("does not activate ambiguous shorthand model owners", () => {
    const result = autoEnable(
      { agents: { defaults: { model: "gpt-5.4" } } },
      ["openai", "proxy-openai"].map((id) => ({
        id,
        channels: [],
        modelSupport: { modelPrefixes: ["gpt-"] },
      })),
    );
    expect(result.config.plugins?.entries?.openai).toBeUndefined();
    expect(result.config.plugins?.entries?.["proxy-openai"]).toBeUndefined();
    expect(result.changes).toEqual([]);
  });
});
