import { beforeAll, beforeEach, describe, it, vi } from "vitest";
import {
  expectAugmentedCodexCatalog,
  expectCodexBuiltInSuppression,
  expectCodexMissingAuthHint,
} from "../../../src/plugins/provider-runtime.test-support.js";
import type { ProviderPlugin } from "../../../src/plugins/types.js";
import { registerProviderPlugin, requireRegisteredProvider } from "./provider-registration.js";

const PROVIDER_CATALOG_CONTRACT_TIMEOUT_MS = 300_000;

type ResolvePluginProviders =
  typeof import("../../../src/plugins/providers.runtime.js").resolvePluginProviders;
type ResolveOwningPluginIdsForProvider =
  typeof import("../../../src/plugins/providers.js").resolveOwningPluginIdsForProvider;
type ResolveCatalogHookProviderPluginIds =
  typeof import("../../../src/plugins/providers.js").resolveCatalogHookProviderPluginIds;

const resolvePluginProvidersMock = vi.hoisted(() => vi.fn<ResolvePluginProviders>(() => []));
const resolveOwningPluginIdsForProviderMock = vi.hoisted(() =>
  vi.fn<ResolveOwningPluginIdsForProvider>(() => undefined),
);
const resolveCatalogHookProviderPluginIdsMock = vi.hoisted(() =>
  vi.fn<ResolveCatalogHookProviderPluginIds>((_) => [] as string[]),
);

vi.mock("../../../src/plugins/providers.js", () => ({
  resolveOwningPluginIdsForProvider: (params: unknown) =>
    resolveOwningPluginIdsForProviderMock(params as never),
  resolveCatalogHookProviderPluginIds: (params: unknown) =>
    resolveCatalogHookProviderPluginIdsMock(params as never),
}));

vi.mock("../../../src/plugins/providers.runtime.js", () => ({
  resolvePluginProviders: (params: unknown) => resolvePluginProvidersMock(params as never),
}));

export function describeOpenAIProviderCatalogContract() {
  let augmentModelCatalogWithProviderPlugins: typeof import("../../../src/plugins/provider-runtime.js").augmentModelCatalogWithProviderPlugins;
  let resetProviderRuntimeHookCacheForTest: typeof import("../../../src/plugins/provider-runtime.js").resetProviderRuntimeHookCacheForTest;
  let resolveProviderBuiltInModelSuppression: typeof import("../../../src/plugins/provider-runtime.js").resolveProviderBuiltInModelSuppression;
  let openaiProviders: ProviderPlugin[];
  let openaiProvider: ProviderPlugin;

  describe(
    "openai provider catalog contract",
    { timeout: PROVIDER_CATALOG_CONTRACT_TIMEOUT_MS },
    () => {
      beforeAll(async () => {
        vi.resetModules();
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
        } = await import("../../../src/plugins/provider-runtime.js"));
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

        resolveCatalogHookProviderPluginIdsMock.mockReset();
        resolveCatalogHookProviderPluginIdsMock.mockReturnValue(["openai"]);
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
    },
  );
}
