import { beforeEach, expect, it, vi } from "vitest";
import {
  buildLiveModelProviderConfig,
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";
import {
  buildCatalogModel as buildModel,
  catalogFixture,
  catalogResponse,
} from "./provider-catalog.test-support.js";

const catalog = catalogFixture("provider", "https://provider.example.test/v1", [
  buildModel("fallback-model"),
]);
const response = (data: unknown[], release = async () => undefined) =>
  catalogResponse({ data }, release, catalog.endpoint);
const projectRows = (field: "slug" | "id") => (rows: readonly unknown[]) =>
  rows.flatMap((row) => {
    const value: unknown = row && typeof row === "object" ? Reflect.get(row, field) : undefined;
    return typeof value !== "string" || (field === "slug" && !value.trim())
      ? []
      : [buildModel(field === "slug" ? value.trim() : value)];
  });

beforeEach(() => clearLiveCatalogCacheForTests());

it("preserves identity-specific size facts through live catalog projection", async () => {
  const fetchGuard: LiveModelCatalogFetchGuard = async () =>
    response([
      { id: "known-chat", parameterCount: 4_000_000_000 },
      { id: "enriched-chat", parameterCount: 4_000_000_000 },
      { id: "novel-chat", parameterCount: 4_000_000_000 },
      { id: "template-next" },
      { id: "invalid-chat", parameterCount: 0 },
    ]);
  const provider = await buildLiveModelProviderConfig({
    ...catalog,
    models: [
      { ...buildModel("known-chat"), parameterCount: 70_000_000_000 },
      buildModel("enriched-chat"),
      { ...buildModel("template-base"), parameterCount: 7_000_000_000 },
    ],
    fetchGuard,
  });
  expect(
    Object.fromEntries(provider.models.map((model) => [model.id, model.parameterCount])),
  ).toEqual({
    "known-chat": 70_000_000_000,
    "enriched-chat": 4_000_000_000,
    "novel-chat": 4_000_000_000,
    "template-next": undefined,
    "invalid-chat": undefined,
  });
});

it("keeps cache admission and fallback shared", async () => {
  const release = vi.fn(async () => undefined);
  const fetchGuard = vi
    .fn<LiveModelCatalogFetchGuard>()
    .mockResolvedValueOnce(response([{ slug: "" }], release))
    .mockResolvedValueOnce(response([{ slug: "projected-model" }], release));
  const buildProvider = async () =>
    await buildLiveModelProviderConfig({
      ...catalog,
      fetchGuard,
      ttlMs: 60_000,
      projectRows: projectRows("slug"),
    });

  expect((await buildProvider()).models.map((model) => model.id)).toEqual(["fallback-model"]);
  expect((await buildProvider()).models.map((model) => model.id)).toEqual(["projected-model"]);
  expect(fetchGuard).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledTimes(2);
});

it("caches the anonymous fallback independently after an authenticated 401", async () => {
  const release = vi.fn(async () => undefined);
  const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>(async ({ init }) => ({
    response: new Headers(init?.headers).has("authorization")
      ? new Response("", { status: 401 })
      : Response.json({ data: [{ id: "public-model", object: "model" }] }),
    finalUrl: catalog.endpoint,
    release,
  }));
  const buildProvider = async () =>
    await buildLiveModelProviderConfig({
      ...catalog,
      apiKey: "runtime-key",
      discoveryApiKey: "rejected-key",
      fetchGuard,
      ttlMs: 60_000,
      fallbackToAnonymousOnUnauthorized: true,
      projectRows: projectRows("id"),
    });

  const first = await buildProvider();
  const second = await buildProvider();
  expect(first.apiKey).toBe("runtime-key");
  expect(first.models.map((model) => model.id)).toEqual(["public-model"]);
  expect(second.models.map((model) => model.id)).toEqual(["public-model"]);
  expect(fetchGuard).toHaveBeenCalledTimes(3);
  expect(release).toHaveBeenCalledTimes(3);
});
