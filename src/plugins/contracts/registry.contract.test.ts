// Registry contract tests cover plugin contract registry contents and lookup behavior.
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { describe, expect, it } from "vitest";
import { resolveManifestContractPluginIds } from "../plugin-registry.js";
import { BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS } from "./inventory/bundled-capability-metadata.js";
import { pluginRegistrationContractRegistry, providerContractLoadError } from "./registry.js";

const ACTIVATION_SCOPED_WEB_SEARCH_PLUGIN_IDS = ["codex", "qa-lab"] as const;
const ACTIVATION_SCOPED_WEB_SEARCH_PLUGIN_ID_SET = new Set<string>(
  ACTIVATION_SCOPED_WEB_SEARCH_PLUGIN_IDS,
);

describe("plugin contract registry", () => {
  it("loads bundled non-provider capability registries without import-time failure", () => {
    expect(providerContractLoadError).toBeUndefined();
    expect(Array.from(pluginRegistrationContractRegistry)).toStrictEqual(
      BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS,
    );
  });

  it("covers every bundled web fetch plugin from the shared resolver", () => {
    const bundledWebFetchPluginIds = resolveManifestContractPluginIds({
      contract: "webFetchProviders",
      origin: "bundled",
    });

    expect(
      sortUniqueStrings(
        pluginRegistrationContractRegistry
          .filter((entry) => entry.webFetchProviderIds.length > 0)
          .map((entry) => entry.pluginId),
      ),
    ).toEqual(bundledWebFetchPluginIds);
  });

  it("covers every bundled web search plugin from the shared resolver", () => {
    const snapshotPluginIds = new Set(
      BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.map((entry) => entry.pluginId),
    );
    const bundledWebSearchPluginIds = resolveManifestContractPluginIds({
      contract: "webSearchProviders",
      origin: "bundled",
    }).filter(
      (pluginId) =>
        snapshotPluginIds.has(pluginId) &&
        !ACTIVATION_SCOPED_WEB_SEARCH_PLUGIN_ID_SET.has(pluginId),
    );
    const expectedPluginIds = sortUniqueStrings([
      ...bundledWebSearchPluginIds,
      ...ACTIVATION_SCOPED_WEB_SEARCH_PLUGIN_IDS,
    ]);
    const actualPluginIds = sortUniqueStrings(
      pluginRegistrationContractRegistry
        .filter((entry) => entry.webSearchProviderIds.length > 0)
        .map((entry) => entry.pluginId),
    );

    expect(actualPluginIds).toEqual(expectedPluginIds);
    expect(
      actualPluginIds.filter((pluginId) => !bundledWebSearchPluginIds.includes(pluginId)),
    ).toEqual([...ACTIVATION_SCOPED_WEB_SEARCH_PLUGIN_IDS]);
  });
});
