import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  loadCatalog: vi.fn(),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  getPreparedModelCatalogSnapshot: (...args: unknown[]) => mocks.getSnapshot(...args),
  readPreparedModelCatalog: (...args: unknown[]) => mocks.loadCatalog(...args),
}));

import {
  loadModelCatalog,
  loadPreparedModelCatalog,
  resolveThinkingDefaultWithRuntimeCatalog,
} from "openclaw/plugin-sdk/agent-runtime";

describe("agent-runtime model catalog compatibility", () => {
  beforeEach(() => {
    mocks.getSnapshot.mockReset();
    mocks.loadCatalog.mockReset();
  });

  it("uses the shipped thinking catalog callback", async () => {
    const readCatalog = vi.fn(async () => []);

    await expect(
      resolveThinkingDefaultWithRuntimeCatalog({
        cfg: { agents: { defaults: { thinkingDefault: "low" } } },
        provider: "example",
        model: "example-model",
        loadModelCatalog: readCatalog,
      }),
    ).resolves.toBe("low");
    expect(readCatalog).toHaveBeenCalledOnce();
  });

  it("propagates failures from the shipped thinking catalog callback", async () => {
    const failure = new Error("catalog unavailable");

    await expect(
      resolveThinkingDefaultWithRuntimeCatalog({
        cfg: {},
        provider: "example",
        model: "example-model",
        loadModelCatalog: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it.each([
    ["prepared", loadPreparedModelCatalog],
    ["legacy", loadModelCatalog],
  ] as const)("preserves the writable default of the %s SDK loader", async (_name, load) => {
    const entries = [{ provider: "test", id: "discovered", name: "Discovered" }];
    mocks.loadCatalog.mockResolvedValue(entries);

    await expect(load()).resolves.toBe(entries);
    expect(mocks.loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: false });
    expect(mocks.getSnapshot).not.toHaveBeenCalled();
  });

  it.each([true, false])("preserves explicit readOnly:%s in the SDK loader", async (readOnly) => {
    const config = {};
    const entries = [{ provider: "test", id: "selected", name: "Selected" }];
    mocks.loadCatalog.mockResolvedValue(entries);

    await expect(loadPreparedModelCatalog({ config, readOnly })).resolves.toBe(entries);
    expect(mocks.loadCatalog).toHaveBeenCalledExactlyOnceWith({ config, readOnly });
  });

  it("keeps legacy cache-only reads nonblocking", async () => {
    mocks.getSnapshot.mockReturnValue({
      entries: [{ provider: "test", id: "cached", name: "Cached" }],
      routeVariants: [],
    });

    await expect(
      loadModelCatalog({ cacheOnly: true, useCache: true, refreshFullCatalog: true }),
    ).resolves.toEqual([{ provider: "test", id: "cached", name: "Cached" }]);
    expect(mocks.loadCatalog).not.toHaveBeenCalled();
  });

  it("preserves explicit refresh intent through the legacy loader", async () => {
    const entries = [{ provider: "test", id: "refreshed", name: "Refreshed" }];
    mocks.loadCatalog.mockResolvedValue(entries);

    await expect(loadModelCatalog({ refreshFullCatalog: true })).resolves.toBe(entries);
    expect(mocks.loadCatalog).toHaveBeenCalledExactlyOnceWith({
      readOnly: false,
      refreshFullCatalog: true,
    });
    expect(mocks.getSnapshot).not.toHaveBeenCalled();
  });

  it("accepts legacy options without overriding lifecycle metadata", async () => {
    type LegacyMetadataSnapshot = Omit<
      PluginMetadataSnapshot,
      "owners" | "declaredProviderOwners"
    > & {
      owners: Omit<PluginMetadataSnapshot["owners"], "modelIdNormalizationPolicies">;
    };
    type AcceptedMetadataSnapshot = NonNullable<
      NonNullable<Parameters<typeof loadModelCatalog>[0]>["metadataSnapshot"]
    >;
    expectTypeOf<LegacyMetadataSnapshot>().toMatchTypeOf<AcceptedMetadataSnapshot>();
    expectTypeOf<PluginMetadataSnapshot>().toMatchTypeOf<AcceptedMetadataSnapshot>();
    mocks.loadCatalog.mockResolvedValue([]);
    const config = {};
    const env = { OPENCLAW_STATE_DIR: "/tmp/plugin-state" };

    await loadModelCatalog({
      agentDir: "/tmp/plugin-agent",
      config,
      env,
      metadataSnapshot: {} as never,
      readOnly: true,
      useCache: false,
      workspaceDir: "/tmp/plugin-workspace",
    });

    expect(mocks.loadCatalog).toHaveBeenCalledWith({
      agentDir: "/tmp/plugin-agent",
      config,
      env,
      readOnly: true,
      workspaceDir: "/tmp/plugin-workspace",
    });
  });
});
