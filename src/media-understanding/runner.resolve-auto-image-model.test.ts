import { afterEach, describe, expect, it, vi } from "vitest";

const resolveApiKeyForProviderMock = vi.fn(async () => "ok");
const loadModelCatalogMock = vi.fn(async () => []);
const findModelInCatalogMock = vi.fn(
  (
    catalog: Array<{ provider: string; id: string; input?: string[] }>,
    provider: string,
    modelId: string,
  ) =>
    catalog.find(
      (entry) =>
        entry.provider.toLowerCase() === provider.toLowerCase() &&
        entry.id.toLowerCase() === modelId.toLowerCase(),
    ),
);
const modelSupportsVisionMock = vi.fn(
  (entry: { input?: string[] } | undefined) => entry?.input?.includes("image") ?? false,
);

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("../agents/model-catalog.js", () => ({
  findModelInCatalog: findModelInCatalogMock,
  loadModelCatalog: loadModelCatalogMock,
  modelSupportsVision: modelSupportsVisionMock,
}));

describe("resolveAutoImageModel", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to provider default image model when active model is text-only", async () => {
    loadModelCatalogMock.mockResolvedValue([
      { provider: "minimax-portal", id: "MiniMax-M2.5", input: ["text"] },
      { provider: "minimax-portal", id: "MiniMax-VL-01", input: ["text", "image"] },
    ]);

    const { resolveAutoImageModel } = await import("./runner.js");
    const resolved = await resolveAutoImageModel({
      cfg: {} as never,
      activeModel: { provider: "minimax-portal", model: "MiniMax-M2.5" },
    });

    expect(resolved).toEqual({ provider: "minimax-portal", model: "MiniMax-VL-01" });
  });

  it("keeps active model when catalog has no model metadata", async () => {
    loadModelCatalogMock.mockResolvedValue([]);

    const { resolveAutoImageModel } = await import("./runner.js");
    const resolved = await resolveAutoImageModel({
      cfg: {} as never,
      activeModel: { provider: "minimax-portal", model: "unknown-model-id" },
    });

    expect(resolved).toEqual({ provider: "minimax-portal", model: "unknown-model-id" });
  });
});
