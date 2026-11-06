import { beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import type { PluginMetadataSnapshot as Metadata } from "../plugins/plugin-metadata-snapshot.types.js";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  loadCatalog: vi.fn(),
}));
const entries = [{ provider: "test", id: "selected", name: "Selected" }];

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  refreshExpiredPreparedModelCatalog: (...args: unknown[]) => mocks.getSnapshot(...args),
  readPreparedModelCatalog: (...args: unknown[]) => mocks.loadCatalog(...args),
}));

import {
  getPreparedModelCatalogSnapshot,
  loadModelCatalog,
  loadPreparedModelCatalog,
  resolveThinkingDefaultWithRuntimeCatalog,
} from "openclaw/plugin-sdk/agent-runtime";

beforeEach(() => {
  mocks.getSnapshot.mockReset().mockReturnValue({ entries, routeVariants: [] });
  mocks.loadCatalog.mockReset().mockResolvedValue(entries);
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

it("preserves explicit readOnly:true in the SDK loader", async () => {
  const options = { config: {}, readOnly: true };
  await expect(loadPreparedModelCatalog(options)).resolves.toBe(entries);
  expect(mocks.loadCatalog).toHaveBeenCalledExactlyOnceWith(options);
});

it.each([
  [
    "legacy cache-only",
    () => loadModelCatalog({ cacheOnly: true, useCache: true, refreshFullCatalog: true }),
  ],
  ["snapshot", () => getPreparedModelCatalogSnapshot()?.entries ?? []],
] as const)("keeps %s reads nonblocking", async (_name, read) => {
  expect(await read()).toEqual(entries);
  expect(mocks.loadCatalog).not.toHaveBeenCalled();
});

it("preserves explicit refresh intent through the legacy loader", async () => {
  await expect(loadModelCatalog({ refreshFullCatalog: true })).resolves.toBe(entries);
  expect(mocks.loadCatalog).toHaveBeenCalledExactlyOnceWith({
    readOnly: false,
    refreshFullCatalog: true,
  });
  expect(mocks.getSnapshot).not.toHaveBeenCalled();
});

it("accepts legacy options without overriding lifecycle metadata", async () => {
  type NewOwners = "modelIdNormalizationPolicies" | "providerAuthContributions";
  type Owners = Omit<Metadata["owners"], NewOwners>;
  type LegacyMetadata = Omit<Metadata, "owners" | "declaredProviderOwners"> & { owners: Owners };
  type Options = NonNullable<Parameters<typeof loadModelCatalog>[0]>;
  type Accepted = NonNullable<Options["metadataSnapshot"]>;
  expectTypeOf<LegacyMetadata>().toMatchTypeOf<Accepted>();
  expectTypeOf<Metadata>().toMatchTypeOf<Accepted>();
  mocks.loadCatalog.mockResolvedValue([]);
  const options = {
    agentDir: "/tmp/plugin-agent",
    config: {},
    env: { OPENCLAW_STATE_DIR: "/tmp/plugin-state" },
    readOnly: true,
    workspaceDir: "/tmp/plugin-workspace",
  };
  await loadModelCatalog({ ...options, metadataSnapshot: {} as never, useCache: false });
  expect(mocks.loadCatalog).toHaveBeenCalledWith(options);
});
