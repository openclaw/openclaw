import { beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(
      buildProviderMissingAuthMessageWithPlugin({
        provider: "openai",
        env: process.env,
        context: {
          env: process.env,
          provider: "openai",
          listProfileIds: (providerId) => (providerId === "openai-codex" ? ["p1"] : []),
        },
      }),
    ).toContain("openai-codex/gpt-5.4");
  });

  it("keeps built-in model suppression wired through the provider runtime", () => {
    expect(
      resolveProviderBuiltInModelSuppression({
        env: process.env,
        context: {
          env: process.env,
          provider: "azure-openai-responses",
          modelId: "gpt-5.3-codex-spark",
        },
      }),
    ).toMatchObject({
      suppress: true,
      errorMessage: expect.stringContaining("openai-codex/gpt-5.3-codex-spark"),
    });
  });

  it("keeps bundled model augmentation wired through the provider runtime", async () => {
    await expect(
      augmentModelCatalogWithProviderPlugins({
        env: process.env,
        context: {
          env: process.env,
          entries: [
            { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
            { provider: "openai", id: "gpt-5.2-pro", name: "GPT-5.2 Pro" },
            { provider: "openai-codex", id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
          ],
        },
      }),
    ).resolves.toEqual([
      { provider: "openai", id: "gpt-5.4", name: "gpt-5.4" },
      { provider: "openai", id: "gpt-5.4-pro", name: "gpt-5.4-pro" },
      { provider: "openai-codex", id: "gpt-5.4", name: "gpt-5.4" },
      {
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
        name: "gpt-5.3-codex-spark",
      },
    ]);
  });
});
