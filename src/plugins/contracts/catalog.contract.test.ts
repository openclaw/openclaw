import { beforeEach, describe, it, vi } from "vitest";
import {
  expectAugmentedCodexCatalog,
  expectCodexBuiltInSuppression,
  expectCodexMissingAuthHint,
} from "../provider-runtime.test-support.js";

type ResolvePluginProviders = typeof import("../providers.js").resolvePluginProviders;
type ResolveOwningPluginIdsForProvider =
  typeof import("../providers.js").resolveOwningPluginIdsForProvider;
type ResolveNonBundledProviderPluginIds =
  typeof import("../providers.js").resolveNonBundledProviderPluginIds;

let resolveProviderContractPluginIdsForProvider: typeof import("./registry.js").resolveProviderContractPluginIdsForProvider;
let resolveProviderContractProvidersForPluginIds: typeof import("./registry.js").resolveProviderContractProvidersForPluginIds;
let uniqueProviderContractProviders: typeof import("./registry.js").uniqueProviderContractProviders;

const resolvePluginProvidersMock = vi.hoisted(() =>
  vi.fn<ResolvePluginProviders>((_) => uniqueProviderContractProviders),
);
const resolveOwningPluginIdsForProviderMock = vi.hoisted(() =>
  vi.fn<ResolveOwningPluginIdsForProvider>((params) =>
    resolveProviderContractPluginIdsForProvider(params.provider),
  ),
);
const resolveNonBundledProviderPluginIdsMock = vi.hoisted(() =>
  vi.fn<ResolveNonBundledProviderPluginIds>((_) => [] as string[]),
);

let augmentModelCatalogWithProviderPlugins: typeof import("../provider-runtime.js").augmentModelCatalogWithProviderPlugins;
let buildProviderMissingAuthMessageWithPlugin: typeof import("../provider-runtime.js").buildProviderMissingAuthMessageWithPlugin;
let resetProviderRuntimeHookCacheForTest: typeof import("../provider-runtime.js").resetProviderRuntimeHookCacheForTest;
let resolveProviderBuiltInModelSuppression: typeof import("../provider-runtime.js").resolveProviderBuiltInModelSuppression;

describe("provider catalog contract", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../providers.js");
    ({
      resolveProviderContractPluginIdsForProvider,
      resolveProviderContractProvidersForPluginIds,
      uniqueProviderContractProviders,
    } = await import("./registry.js"));

    resolveOwningPluginIdsForProviderMock.mockReset();
    resolveOwningPluginIdsForProviderMock.mockImplementation((params) =>
      resolveProviderContractPluginIdsForProvider(params.provider),
    );

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

    vi.doMock("../providers.js", () => ({
      resolvePluginProviders: (params: unknown) => resolvePluginProvidersMock(params as never),
      resolveOwningPluginIdsForProvider: (params: unknown) =>
        resolveOwningPluginIdsForProviderMock(params as never),
      resolveNonBundledProviderPluginIds: (params: unknown) =>
        resolveNonBundledProviderPluginIdsMock(params as never),
    }));

    ({
      augmentModelCatalogWithProviderPlugins,
      buildProviderMissingAuthMessageWithPlugin,
      resetProviderRuntimeHookCacheForTest,
      resolveProviderBuiltInModelSuppression,
    } = await import("../provider-runtime.js"));
    resetProviderRuntimeHookCacheForTest();
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
