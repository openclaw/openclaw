import { beforeAll, beforeEach, describe, it, vi } from "vitest";
import {
  expectAugmentedCodexCatalog,
  expectCodexBuiltInSuppression,
  expectCodexMissingAuthHint,
} from "../provider-runtime.test-support.js";
import { requireProviderContractProvider } from "./registry.js";

type ResolvePluginProviders = typeof import("../providers.js").resolvePluginProviders;
type ResolveOwningPluginIdsForProvider =
  typeof import("../providers.js").resolveOwningPluginIdsForProvider;
type ResolveNonBundledProviderPluginIds =
  typeof import("../providers.js").resolveNonBundledProviderPluginIds;

const resolvePluginProvidersMock = vi.hoisted(() => vi.fn<ResolvePluginProviders>(() => []));
const resolveOwningPluginIdsForProviderMock = vi.hoisted(() =>
  vi.fn<ResolveOwningPluginIdsForProvider>((params) =>
    resolveProviderContractPluginIdsForProvider(params.provider),
  ),
);
const resolveNonBundledProviderPluginIdsMock = vi.hoisted(() =>
  vi.fn<ResolveNonBundledProviderPluginIds>((_) => [] as string[]),
);

vi.mock("../providers.js", () => ({
  resolvePluginProviders: (params: unknown) => resolvePluginProvidersMock(params as never),
  resolveOwningPluginIdsForProvider: (params: unknown) =>
    resolveOwningPluginIdsForProviderMock(params as never),
  resolveNonBundledProviderPluginIds: (params: unknown) =>
    resolveNonBundledProviderPluginIdsMock(params as never),
}));

let augmentModelCatalogWithProviderPlugins: typeof import("../provider-runtime.js").augmentModelCatalogWithProviderPlugins;
let resetProviderRuntimeHookCacheForTest: typeof import("../provider-runtime.js").resetProviderRuntimeHookCacheForTest;
let resolveProviderBuiltInModelSuppression: typeof import("../provider-runtime.js").resolveProviderBuiltInModelSuppression;
let resolveProviderContractPluginIdsForProvider: typeof import("./registry.js").resolveProviderContractPluginIdsForProvider;
let resolveProviderContractProvidersForPluginIds: typeof import("./registry.js").resolveProviderContractProvidersForPluginIds;
let uniqueProviderContractProviders: typeof import("./registry.js").uniqueProviderContractProviders;

describe("provider catalog contract", () => {
  beforeAll(async () => {
    ({
      resolveProviderContractPluginIdsForProvider,
      resolveProviderContractProvidersForPluginIds,
      uniqueProviderContractProviders,
    } = await import("./registry.js"));
    ({
      augmentModelCatalogWithProviderPlugins,
      resetProviderRuntimeHookCacheForTest,
      resolveProviderBuiltInModelSuppression,
    } = await import("../provider-runtime.js"));
  });

  beforeEach(() => {
    resetProviderRuntimeHookCacheForTest();

    resolvePluginProvidersMock.mockReset();
    resolvePluginProvidersMock.mockImplementation((params?: { onlyPluginIds?: string[] }) => {
      const onlyPluginIds = params?.onlyPluginIds;
      if (!onlyPluginIds || onlyPluginIds.length === 0) {
        return uniqueProviderContractProviders;
      }
      return resolveProviderContractProvidersForPluginIds(onlyPluginIds);
    });

    resolveOwningPluginIdsForProviderMock.mockReset();
    resolveOwningPluginIdsForProviderMock.mockImplementation((params) =>
      resolveProviderContractPluginIdsForProvider(params.provider),
    );

    resolveNonBundledProviderPluginIdsMock.mockReset();
    resolveNonBundledProviderPluginIdsMock.mockReturnValue([]);
  });

  it("keeps codex-only missing-auth hints wired through the provider runtime", () => {
    const openaiProvider = requireProviderContractProvider("openai");
    expectCodexMissingAuthHint(
      (params) => openaiProvider.buildMissingAuthMessage?.(params.context) ?? undefined,
    );
  });

  it("keeps built-in model suppression wired through the provider runtime", () => {
    expectCodexBuiltInSuppression(resolveProviderBuiltInModelSuppression);
  });

  it("keeps bundled model augmentation wired through the provider runtime", async () => {
    await expectAugmentedCodexCatalog(augmentModelCatalogWithProviderPlugins);
  });
});
