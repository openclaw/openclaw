import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadStaticManifestCatalogRowsForList: vi.fn(),
  loadProviderIndexCatalogRowsForList: vi.fn(),
  hasProviderStaticCatalogForFilter: vi.fn(),
}));

vi.mock("./list.manifest-catalog.js", () => ({
  loadStaticManifestCatalogRowsForList: mocks.loadStaticManifestCatalogRowsForList,
}));

vi.mock("./list.provider-index-catalog.js", () => ({
  loadProviderIndexCatalogRowsForList: mocks.loadProviderIndexCatalogRowsForList,
}));

vi.mock("./list.provider-catalog.js", () => ({
  hasProviderStaticCatalogForFilter: mocks.hasProviderStaticCatalogForFilter,
}));

const catalogRow = {
  provider: "moonshot",
  id: "kimi-k2.6",
  ref: "moonshot/kimi-k2.6",
  mergeKey: "moonshot::kimi-k2.6",
  name: "Kimi K2.6",
  source: "manifest",
  input: ["text"],
  reasoning: false,
  status: "available",
} as const;

describe("planAllModelListSources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadStaticManifestCatalogRowsForList.mockReturnValue([]);
    mocks.loadProviderIndexCatalogRowsForList.mockReturnValue([]);
    mocks.hasProviderStaticCatalogForFilter.mockResolvedValue(false);
  });

  it("uses installed manifest rows before provider index or runtime catalog sources", async () => {
    const { planAllModelListSources } = await import("./list.source-plan.js");
    mocks.loadStaticManifestCatalogRowsForList.mockReturnValueOnce([catalogRow]);

    const plan = await planAllModelListSources({
      all: true,
      providerFilter: "moonshot",
      cfg: {},
    });

    expect(plan).toMatchObject({
      kind: "manifest",
      requiresInitialRegistry: false,
      skipRuntimeModelSuppression: true,
    });
    expect(plan.manifestCatalogRows).toEqual([catalogRow]);
    expect(mocks.loadProviderIndexCatalogRowsForList).not.toHaveBeenCalled();
    expect(mocks.hasProviderStaticCatalogForFilter).not.toHaveBeenCalled();
  });

  it("uses provider index rows only when installed manifest rows are unavailable", async () => {
    const { planAllModelListSources } = await import("./list.source-plan.js");
    const providerIndexRow = { ...catalogRow, source: "provider-index" };
    mocks.loadProviderIndexCatalogRowsForList.mockReturnValueOnce([providerIndexRow]);

    const plan = await planAllModelListSources({
      all: true,
      providerFilter: "moonshot",
      cfg: {},
    });

    expect(plan).toMatchObject({
      kind: "provider-index",
      requiresInitialRegistry: false,
      skipRuntimeModelSuppression: true,
    });
    expect(plan.providerIndexCatalogRows).toEqual([providerIndexRow]);
    expect(mocks.hasProviderStaticCatalogForFilter).not.toHaveBeenCalled();
  });

  it("keeps scoped runtime catalog fallback separate from broad registry loading", async () => {
    const { planAllModelListSources } = await import("./list.source-plan.js");

    await expect(
      planAllModelListSources({
        all: true,
        providerFilter: "openrouter",
        cfg: {},
      }),
    ).resolves.toMatchObject({
      kind: "provider-runtime-scoped",
      requiresInitialRegistry: false,
      skipRuntimeModelSuppression: false,
      fallbackToRegistryWhenEmpty: false,
    });
  });

  it("falls back to registry only for provider static fast paths that return no rows", async () => {
    const { planAllModelListSources } = await import("./list.source-plan.js");
    mocks.hasProviderStaticCatalogForFilter.mockResolvedValueOnce(true);

    await expect(
      planAllModelListSources({
        all: true,
        providerFilter: "codex",
        cfg: {},
      }),
    ).resolves.toMatchObject({
      kind: "provider-runtime-static",
      requiresInitialRegistry: false,
      skipRuntimeModelSuppression: true,
      fallbackToRegistryWhenEmpty: true,
    });
  });
});
