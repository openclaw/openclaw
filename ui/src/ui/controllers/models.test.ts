import { describe, expect, it, vi } from "vitest";
import {
  ensureModelCatalog,
  loadModels,
  refreshModelCatalog,
  type ModelCatalogState,
} from "./models.ts";

function createState(
  request: (method: string, params: unknown) => Promise<unknown>,
  overrides: Partial<ModelCatalogState> = {},
): ModelCatalogState {
  return {
    client: { request } as never,
    connected: true,
    chatModelsLoading: false,
    chatModelCatalog: [],
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("loadModels", () => {
  it("returns an empty array when the gateway request fails", async () => {
    const models = await loadModels({
      request: vi.fn().mockRejectedValue(new Error("offline")),
    } as never);

    expect(models).toEqual([]);
  });
});

describe("refreshModelCatalog", () => {
  it("hydrates the shared model catalog", async () => {
    const request = vi.fn().mockResolvedValue({
      models: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" }],
    });
    const state = createState(request);

    await refreshModelCatalog(state);

    expect(request).toHaveBeenCalledWith("models.list", {});
    expect(state.chatModelsLoading).toBe(false);
    expect(state.chatModelCatalog).toEqual([
      { id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" },
    ]);
  });

  it("keeps the last known catalog when a refresh fails", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    const state = createState(request, {
      chatModelCatalog: [{ id: "gpt-5", name: "GPT-5", provider: "openai" }],
    });

    await refreshModelCatalog(state);

    expect(state.chatModelsLoading).toBe(false);
    expect(state.chatModelCatalog).toEqual([{ id: "gpt-5", name: "GPT-5", provider: "openai" }]);
  });

  it("awaits the existing in-flight refresh instead of returning early", async () => {
    const deferred = createDeferred<{
      models: Array<{ id: string; name: string; provider: string }>;
    }>();
    const request = vi.fn().mockReturnValue(deferred.promise);
    const state = createState(request);

    const first = refreshModelCatalog(state);
    let secondResolved = false;
    const second = refreshModelCatalog(state).then(() => {
      secondResolved = true;
    });

    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(secondResolved).toBe(false);

    deferred.resolve({
      models: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" }],
    });

    await first;
    await second;
    expect(secondResolved).toBe(true);
    expect(state.chatModelCatalog).toEqual([
      { id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" },
    ]);
  });
});

describe("ensureModelCatalog", () => {
  it("loads models when the shared catalog is still empty", async () => {
    const request = vi.fn().mockResolvedValue({
      models: [{ id: "sonnet-4.6", name: "Sonnet 4.6", provider: "anthropic" }],
    });
    const state = createState(request);

    await ensureModelCatalog(state);

    expect(request).toHaveBeenCalledTimes(1);
    expect(state.chatModelCatalog).toEqual([
      { id: "sonnet-4.6", name: "Sonnet 4.6", provider: "anthropic" },
    ]);
  });

  it("does not refetch when the shared catalog is already populated", async () => {
    const request = vi.fn();
    const state = createState(request, {
      chatModelCatalog: [{ id: "gpt-5", name: "GPT-5", provider: "openai" }],
    });

    await ensureModelCatalog(state);

    expect(request).not.toHaveBeenCalled();
  });
});
