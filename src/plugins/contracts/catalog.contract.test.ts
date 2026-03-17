import { beforeEach, describe, it, vi } from "vitest";
import {
  expectAugmentedCodexCatalog,
  expectCodexBuiltInSuppression,
  expectCodexMissingAuthHint,
} from "../provider-runtime.test-support.js";
import {
  providerContractPluginIds,
  resolveProviderContractProvidersForPluginIds,
  uniqueProviderContractProviders,
} from "./registry.js";

const resolvePluginProvidersMock = vi.fn();
const resolveOwningPluginIdsForProviderMock = vi.fn();
const resolveNonBundledProviderPluginIdsMock = vi.fn();

vi.mock("../providers.js", () => ({
  resolvePluginProviders: (...args: unknown[]) => resolvePluginProvidersMock(...args),
  resolveOwningPluginIdsForProvider: (...args: unknown[]) =>
    resolveOwningPluginIdsForProviderMock(...args),
  resolveNonBundledProviderPluginIds: (...args: unknown[]) =>
    resolveNonBundledProviderPluginIdsMock(...args),
}));

const {
  augmentModelCatalogWithProviderPlugins,
  buildProviderMissingAuthMessageWithPlugin,
  resetProviderRuntimeHookCacheForTest,
  resolveProviderBuiltInModelSuppression,
} = await import("../provider-runtime.js");

describe("provider catalog contract", () => {
  beforeEach(() => {
    resetProviderRuntimeHookCacheForTest();

    resolveOwningPluginIdsForProviderMock.mockReset();
    resolveOwningPluginIdsForProviderMock.mockReturnValue(providerContractPluginIds);

    resolveNonBundledProviderPluginIdsMock.mockReset();
    resolveNonBundledProviderPluginIdsMock.mockReturnValue([]);

    resolvePluginProvidersMock.mockReset();
    resolvePluginProvidersMock.mockImplementation((params?: { onlyPluginIds?: string[] }) => {
      const onlyPluginIds = params?.onlyPluginIds;
      if (!onlyPluginIds || onlyPluginIds.length === 0) {
        return uniqueProviderContractProviders;
      }
      return resolveProviderContractProvidersForPluginIds(onlyPluginIds);
    });
  });

  it("keeps codex-only missing-auth hints wired through the provider runtime", () => {
    expectCodexMissingAuthHint(buildProviderMissingAuthMessageWithPlugin);
  });

  it("keeps built-in model suppression wired through the provider runtime", () => {
    expectCodexBuiltInSuppression(resolveProviderBuiltInModelSuppression);
  });

  it("keeps bundled model augmentation wired through the provider runtime", async () => {
    await expectAugmentedCodexCatalog(augmentModelCatalogWithProviderPlugins);
  });
});
