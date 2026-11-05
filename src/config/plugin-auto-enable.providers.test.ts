import { afterAll, expect, it } from "vitest";
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
const restricted = (config: OpenClawConfig, plugins?: ManifestPlugin[]) =>
  autoEnable({ ...config, plugins: { allow: ["telegram"] } }, plugins);
function expectEnabled(result: ReturnType<typeof autoEnable>, id: string) {
  expect(result.config.plugins).toMatchObject({
    allow: ["telegram", id],
    entries: { [id]: { enabled: true } },
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
    archive: { provider: " ARCHIVE-OBJECTS ", settings: {}, encryption: "none" as const },
  },
};

afterAll(resetPluginAutoEnableTestState);

it.each<[string, OpenClawConfig, ManifestPlugin["contracts"]]>([
  [
    "decision-plugin",
    { agents: { defaults: { decisionModel: "judge/fast" } } },
    { decisionProviders: ["judge"] },
  ],
  [
    "qa-lab",
    { cloudWorkers: { profiles: { development: { provider: " STATIC-SSH " } } } },
    { workerProviders: ["static-ssh"] },
  ],
  ["storage-fixture", { storage }, { storageProviders: ["archive-objects"] }],
])("activates the selected bundled contract owner %s", (id, config, contracts) => {
  const result = restricted(config, [provider(id, contracts, "bundled")]);
  expectEnabled(result, id);
  expect(result.autoEnabledReasons[id]).toHaveLength(1);
});

it.each<OpenClawConfig>([
  { auth: { profiles: { "google:default": { provider: "google", mode: "api_key" } } } },
  { models: { providers: { google: { baseUrl: "https://example.test", models: [] } } } },
])("auto-enables Google from auth or provider config: %j", (config) => {
  expectEnabled(restricted(config), "google");
});

it("auto-enables selected web search provider plugins under restrictive allowlists", () => {
  const result = restricted({ tools: { web: { search: { provider: "brave" } } } }, [
    provider("brave", { webSearchProviders: ["brave"] }),
  ]);

  expectEnabled(result, "brave");
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
  const result = restricted(
    {
      tools: { web: { search: { enabled: false, provider: "brave" } } },
      agents: { defaults: { model: "codex/gpt-5.4" } },
    },
    [
      provider("brave", { webSearchProviders: ["brave"] }),
      { id: "codex", channels: [], providers: ["codex"] },
    ],
  );

  expectEnabled(result, "codex");
  expect(result.config.plugins?.entries?.brave).toBeUndefined();
});

it.each<[Record<string, unknown>, ManifestPlugin]>([
  [
    { webSearch: { apiKey: "acme-search-key" } },
    { ...provider("acme", { webSearchProviders: ["acme-search"] }), providers: ["acme-ai"] },
  ],
  [
    { acmeTool: { enabled: true } },
    {
      ...provider("acme", { tools: ["acme_tool"] }),
      configSchema: { type: "object", properties: { acmeTool: { type: "object" } } },
    },
  ],
])("auto-enables manifest-owned third-party config: %j", (config, plugin) => {
  const result = autoEnable({ plugins: { entries: { acme: { config } } } }, [plugin]);
  expect(result.config.plugins?.entries?.acme?.enabled).toBe(true);
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
