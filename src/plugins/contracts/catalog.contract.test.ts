import { beforeAll, beforeEach, describe, it, vi } from "vitest";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../../test/helpers/extensions/provider-registration.js";
import {
  expectAugmentedCodexCatalog,
  expectCodexBuiltInSuppression,
  expectCodexMissingAuthHint,
} from "../provider-runtime.test-support.js";
import type { ProviderPlugin } from "../types.js";

const PROVIDER_CATALOG_CONTRACT_TIMEOUT_MS = 300_000;

type ResolvePluginProviders = typeof import("../providers.runtime.js").resolvePluginProviders;
type ResolveOwningPluginIdsForProvider =
  typeof import("../providers.js").resolveOwningPluginIdsForProvider;
type ResolveNonBundledProviderPluginIds =
  typeof import("../providers.js").resolveNonBundledProviderPluginIds;

const resolvePluginProvidersMock = vi.hoisted(() => vi.fn<ResolvePluginProviders>(() => []));
const resolveOwningPluginIdsForProviderMock = vi.hoisted(() =>
  vi.fn<ResolveOwningPluginIdsForProvider>(() => undefined),
);
const resolveNonBundledProviderPluginIdsMock = vi.hoisted(() =>
  vi.fn<ResolveNonBundledProviderPluginIds>((_) => [] as string[]),
);

vi.mock("../providers.js", () => ({
  resolveOwningPluginIdsForProvider: (params: unknown) =>
    resolveOwningPluginIdsForProviderMock(params as never),
  resolveNonBundledProviderPluginIds: (params: unknown) =>
    resolveNonBundledProviderPluginIdsMock(params as never),
}));

vi.mock("../providers.runtime.js", () => ({
  resolvePluginProviders: (params: unknown) => resolvePluginProvidersMock(params as never),
}));

let augmentModelCatalogWithProviderPlugins: typeof import("../provider-runtime.js").augmentModelCatalogWithProviderPlugins;
let resetProviderRuntimeHookCacheForTest: typeof import("../provider-runtime.js").resetProviderRuntimeHookCacheForTest;
let resolveProviderBuiltInModelSuppression: typeof import("../provider-runtime.js").resolveProviderBuiltInModelSuppression;
let openaiProviders: ProviderPlugin[];
let openaiProvider: ProviderPlugin;

describe("provider catalog contract", { timeout: PROVIDER_CATALOG_CONTRACT_TIMEOUT_MS }, () => {
  beforeAll(async () => {
    const openaiPlugin = await import("../../../extensions/openai/index.ts");
    openaiProviders = registerProviderPlugin({
      plugin: openaiPlugin.default,
      id: "openai",
      name: "OpenAI",
    }).providers;
    openaiProvider = requireRegisteredProvider(openaiProviders, "openai", "provider");
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
        return openaiProviders;
      }
      return onlyPluginIds.includes("openai") ? openaiProviders : [];
    });

    resolveOwningPluginIdsForProviderMock.mockReset();
    resolveOwningPluginIdsForProviderMock.mockImplementation((params) => {
      switch (params.provider) {
        case "azure-openai-responses":
        case "openai":
        case "openai-codex":
          return ["openai"];
        default:
          return undefined;
      }
    });

    resolveNonBundledProviderPluginIdsMock.mockReset();
    resolveNonBundledProviderPluginIdsMock.mockReturnValue([]);
  });

  it("keeps codex-only missing-auth hints wired through the provider runtime", () => {
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
