import { afterEach, describe, expect, it, vi } from "vitest";
import { type ModelCatalogEntry } from "../agents/model-catalog.js";

const resolveApiKeyForProviderMock = vi.fn(async () => "ok");
const loadModelCatalogMock = vi.fn<() => Promise<ModelCatalogEntry[]>>(async () => []);
const findModelInCatalogMock = vi.fn(
  (catalog: ModelCatalogEntry[], provider: string, modelId: string) =>
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
    vi.resetAllMocks();
  });

  it("falls back to provider default image model when active model is text-only", async () => {
    loadModelCatalogMock.mockResolvedValue([
      { provider: "minimax-portal", id: "MiniMax-M2.5", name: "MiniMax-M2.5", input: ["text"] },
      {
        provider: "minimax-portal",
        id: "MiniMax-VL-01",
        name: "MiniMax-VL-01",
        input: ["text", "image"],
      },
    ]);

    const { resolveAutoImageModel } = await import("./runner.js");
    const resolved = await resolveAutoImageModel({
      cfg: {} as never,
      activeModel: { provider: "minimax-portal", model: "MiniMax-M2.5" },
    });

    expect(resolved).toEqual({ provider: "minimax-portal", model: "MiniMax-VL-01" });
  });

  it("keeps active model when catalog confirms it supports vision", async () => {
    loadModelCatalogMock.mockResolvedValue([
      {
        provider: "minimax-portal",
        id: "MiniMax-VL-01",
        name: "MiniMax-VL-01",
        input: ["text", "image"],
      },
    ]);

    const { resolveAutoImageModel } = await import("./runner.js");
    const resolved = await resolveAutoImageModel({
      cfg: {} as never,
      activeModel: { provider: "minimax-portal", model: "MiniMax-VL-01" },
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

  it("keeps active model when catalog entry exists but input capability metadata is missing", async () => {
    loadModelCatalogMock.mockResolvedValue([
      { provider: "minimax-portal", id: "MiniMax-M2.5", name: "MiniMax-M2.5" },
    ]);

    const { resolveAutoImageModel } = await import("./runner.js");
    const resolved = await resolveAutoImageModel({
      cfg: {} as never,
      activeModel: { provider: "minimax-portal", model: "MiniMax-M2.5" },
    });

    expect(resolved).toEqual({ provider: "minimax-portal", model: "MiniMax-M2.5" });
  });

  it("keeps requested model when a text-only provider has no default image fallback", async () => {
    loadModelCatalogMock.mockResolvedValue([
      { provider: "moonshot", id: "kimi-k2", name: "Kimi K2", input: ["text"] },
    ]);

    const { resolveAutoImageModel } = await import("./runner.js");
    const resolved = await resolveAutoImageModel({
      cfg: {} as never,
      activeModel: { provider: "moonshot", model: "kimi-k2" },
    });

    expect(resolved).toEqual({ provider: "moonshot", model: "kimi-k2" });
  });
});
