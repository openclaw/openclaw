import { beforeEach, expect, it, vi } from "vitest";
import {
  resolveRecommendedStarterModel,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";

const { refresh, recommendations } = vi.hoisted(() => ({
  refresh: vi.fn(),
  recommendations: vi.fn<() => Promise<readonly string[] | undefined>>(),
}));
vi.mock("../model-catalog/remote-refresh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model-catalog/remote-refresh.js")>()),
  refreshRemoteModelCatalog: refresh,
}));
vi.mock("../model-catalog/remote-overlay.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model-catalog/remote-overlay.js")>()),
  readRemoteModelCatalogProviderRecommendations: recommendations,
}));

const servedBy =
  (ids: string[]): LiveModelCatalogFetchGuard =>
  async () => ({
    response: new Response(JSON.stringify({ data: ids.map((id) => ({ id })) })),
    finalUrl: "https://gateway.example.test/v1/models",
    release: async () => {},
  });

const resolve = (served: string[]) =>
  resolveRecommendedStarterModel({
    providerId: "gateway",
    config: {},
    endpoint: "https://gateway.example.test/v1/models",
    apiKey: "scoped-key",
    auditContext: "test",
    fetchGuard: servedBy(served),
  });

beforeEach(() => {
  refresh.mockReset().mockResolvedValue({ status: "updated" });
  recommendations.mockReset().mockResolvedValue(["vendor/flagship", "vendor/pass-model"]);
});

it("picks the first recommendation the key serves", async () => {
  await expect(resolve(["vendor/pass-model", "vendor/other"])).resolves.toBe(
    "gateway/vendor/pass-model",
  );
  expect(refresh).toHaveBeenCalledOnce();
});

it("returns no default rather than a model the key cannot use", async () => {
  await expect(resolve(["vendor/other"])).resolves.toBeUndefined();
  recommendations.mockResolvedValue(undefined);
  await expect(resolve(["vendor/flagship"])).resolves.toBeUndefined();
});
