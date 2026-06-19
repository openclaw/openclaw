// Loader contract tests cover plugin loader behavior, registry setup, and reset boundaries.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { uniqueSortedStrings } from "../../plugin-sdk/test-helpers/string-utils.js";
import { resolveManifestContractPluginIds } from "../plugin-registry.js";
import { testing as providerTesting } from "../providers.js";
import { resolveBundledContractSnapshotPluginIds } from "./inventory/bundled-capability-metadata.js";
import { providerContractCompatPluginIds } from "./registry.js";

function resolveBundledManifestProviderPluginIds() {
  return uniqueSortedStrings(resolveBundledContractSnapshotPluginIds("providerIds"));
}

const ACTIVATION_SCOPED_WEB_SEARCH_PLUGIN_IDS = ["codex", "qa-lab"] as const;
const ACTIVATION_SCOPED_WEB_SEARCH_PLUGIN_ID_SET = new Set<string>(
  ACTIVATION_SCOPED_WEB_SEARCH_PLUGIN_IDS,
);

function expectPluginAllowlistEquals(
  allow: string[] | undefined,
  pluginIds: string[],
  expectedExtraEntry?: string,
) {
  expect(allow).toEqual(expectedExtraEntry ? [expectedExtraEntry, ...pluginIds] : pluginIds);
}

describe("plugin loader contract", () => {
  let providerPluginIds: string[] = [];
  let manifestProviderPluginIds: string[] = [];
  let vitestCompatConfig: ReturnType<typeof providerTesting.withBundledProviderVitestCompat>;
  let webSearchPluginIds: string[] = [];
  let bundledWebSearchPluginIds: string[] = [];

  beforeAll(() => {
    providerPluginIds = uniqueSortedStrings(providerContractCompatPluginIds);
    manifestProviderPluginIds = resolveBundledManifestProviderPluginIds();
    vitestCompatConfig = providerTesting.withBundledProviderVitestCompat({
      config: undefined,
      pluginIds: providerPluginIds,
      env: { VITEST: "1" } as NodeJS.ProcessEnv,
    });
    webSearchPluginIds = uniqueSortedStrings(
      resolveBundledContractSnapshotPluginIds("webSearchProviderIds"),
    );
    bundledWebSearchPluginIds = uniqueSortedStrings(
      resolveManifestContractPluginIds({
        contract: "webSearchProviders",
        origin: "bundled",
      }),
    );
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps bundled provider registry wired to the manifest inventory", () => {
    expect(providerPluginIds).toEqual(manifestProviderPluginIds);
  });

  it("keeps vitest bundled provider enablement wired to the provider registry", () => {
    expect(providerPluginIds).toEqual(manifestProviderPluginIds);
    expect(vitestCompatConfig?.plugins?.enabled).toBe(true);
    expectPluginAllowlistEquals(vitestCompatConfig?.plugins?.allow, providerPluginIds);
  });

  it("keeps bundled web search loading scoped to the web search registry", () => {
    const loaderScopedPluginIds = bundledWebSearchPluginIds.filter(
      (pluginId) => !ACTIVATION_SCOPED_WEB_SEARCH_PLUGIN_ID_SET.has(pluginId),
    );
    const expectedPluginIds = uniqueSortedStrings([
      ...loaderScopedPluginIds,
      ...ACTIVATION_SCOPED_WEB_SEARCH_PLUGIN_IDS,
    ]);

    expect(webSearchPluginIds).toEqual(expectedPluginIds);
    expect(
      webSearchPluginIds.filter((pluginId) => !loaderScopedPluginIds.includes(pluginId)),
    ).toEqual([...ACTIVATION_SCOPED_WEB_SEARCH_PLUGIN_IDS]);
  });
});
