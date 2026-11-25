import { expect, it, vi } from "vitest";
import { augmentModelCatalogWithProviderPlugins } from "./provider-catalog-augment.js";
import type { ProviderPlugin } from "./types.js";

const fixture = vi.hoisted(() => ({ providers: [] as ProviderPlugin[] }));
// mock-isolation: select the fixture providers without loading the plugin registry.
vi.mock("./providers.js", () => ({
  resolveCatalogHookProviderPluginIds: () => fixture.providers.map((provider) => provider.id),
}));
// mock-isolation: return the fixture providers without loading plugin runtimes.
vi.mock("./provider-hook-runtime.js", () => ({
  resolveProviderPluginsForHooks: () => fixture.providers,
}));

const row = { provider: "healthy", id: "healthy-model", name: "Healthy Model" };

it("keeps other catalog augment rows when one provider's hook throws", async () => {
  fixture.providers = [
    {
      id: "broken",
      label: "broken",
      auth: [],
      augmentModelCatalog: () => {
        throw new Error("augment hook bug");
      },
    },
    { id: "healthy", label: "healthy", auth: [], augmentModelCatalog: () => [row] },
  ];

  await expect(
    augmentModelCatalogWithProviderPlugins({
      config: {},
      env: {},
      workspaceDir: "/tmp/workspace",
      context: { config: {}, env: {}, entries: [] },
    }),
  ).resolves.toEqual([row]);
});
