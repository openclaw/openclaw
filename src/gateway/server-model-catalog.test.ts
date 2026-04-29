import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  loadModelCatalog: vi.fn(),
  resetModelCatalogCacheForTest: vi.fn(),
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: mocks.loadModelCatalog,
  resetModelCatalogCacheForTest: mocks.resetModelCatalogCacheForTest,
}));

import {
  __resetModelCatalogCacheForTest,
  loadGatewayModelCatalog,
  markGatewayModelCatalogStale,
} from "./server-model-catalog.js";

type LoadModelCatalogMockParams = {
  config: OpenClawConfig;
  onRetryableResult?: (reason: "empty" | "error") => void;
};

function createModel(provider: string, id: string): ModelCatalogEntry {
  return { provider, id, name: id };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("loadGatewayModelCatalog", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await __resetModelCatalogCacheForTest();
  });

  it("awaits the first catalog load when no cached catalog exists", async () => {
    const cfg = { models: { providers: {} } } as OpenClawConfig;
    const catalog = [createModel("openai", "gpt-5.4")];
    mocks.loadModelCatalog.mockResolvedValueOnce(catalog);

    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(catalog);

    expect(mocks.loadModelCatalog).toHaveBeenCalledWith(expect.objectContaining({ config: cfg }));
  });

  it("does not cache an empty first-load catalog", async () => {
    const cfg = {} as OpenClawConfig;
    const catalog = [createModel("openai", "gpt-5.4")];
    mocks.loadModelCatalog.mockResolvedValueOnce([]).mockResolvedValueOnce(catalog);

    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual([]);
    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(catalog);

    expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(2);
  });

  it("returns the last successful catalog while a stale refresh is in flight", async () => {
    const cfg = {} as OpenClawConfig;
    const initial = [createModel("openai", "gpt-5.4")];
    const refresh = createDeferred<ModelCatalogEntry[]>();
    mocks.loadModelCatalog.mockResolvedValueOnce(initial).mockReturnValueOnce(refresh.promise);

    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(initial);
    await flushMicrotasks();
    markGatewayModelCatalogStale();

    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(initial);

    await vi.waitFor(() => {
      expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(2);
    });
    expect(mocks.loadModelCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ config: cfg }),
    );
  });

  it("returns the refreshed catalog after background refresh succeeds", async () => {
    const cfg = {} as OpenClawConfig;
    const initial = [createModel("openai", "gpt-5.4")];
    const refreshed = [createModel("anthropic", "claude-sonnet-4.6")];
    const refresh = createDeferred<ModelCatalogEntry[]>();
    mocks.loadModelCatalog.mockResolvedValueOnce(initial).mockReturnValueOnce(refresh.promise);

    await loadGatewayModelCatalog({ getConfig: () => cfg });
    await flushMicrotasks();
    markGatewayModelCatalogStale();
    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(initial);
    await vi.waitFor(() => {
      expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(2);
    });

    refresh.resolve(refreshed);

    await vi.waitFor(async () => {
      await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(refreshed);
    });
    expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(2);
  });

  it("does not clear a newer stale mark when an older background refresh resolves", async () => {
    const cfg = {} as OpenClawConfig;
    const initial = [createModel("openai", "gpt-5.4")];
    const obsolete = [createModel("anthropic", "claude-sonnet-4.6")];
    const latest = [createModel("openai", "gpt-5.5")];
    const obsoleteRefresh = createDeferred<ModelCatalogEntry[]>();
    const latestRefresh = createDeferred<ModelCatalogEntry[]>();
    mocks.loadModelCatalog
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(obsoleteRefresh.promise)
      .mockReturnValueOnce(latestRefresh.promise);

    await loadGatewayModelCatalog({ getConfig: () => cfg });
    await flushMicrotasks();
    markGatewayModelCatalogStale();
    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(initial);
    await vi.waitFor(() => {
      expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(2);
    });

    markGatewayModelCatalogStale();
    obsoleteRefresh.resolve(obsolete);
    await flushMicrotasks();

    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(initial);
    await vi.waitFor(() => {
      expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(3);
    });

    latestRefresh.resolve(latest);
    await vi.waitFor(async () => {
      await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(latest);
    });
    expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(3);
  });

  it("does not clear a stale mark created during the first catalog load", async () => {
    const cfg = {} as OpenClawConfig;
    const initial = [createModel("openai", "gpt-5.4")];
    const latest = [createModel("openai", "gpt-5.5")];
    const firstLoad = createDeferred<ModelCatalogEntry[]>();
    const refresh = createDeferred<ModelCatalogEntry[]>();
    mocks.loadModelCatalog
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValueOnce(refresh.promise);

    const firstResult = loadGatewayModelCatalog({ getConfig: () => cfg });
    await vi.waitFor(() => {
      expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(1);
    });

    markGatewayModelCatalogStale();
    firstLoad.resolve(initial);
    await expect(firstResult).resolves.toEqual(initial);

    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(initial);
    await vi.waitFor(() => {
      expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(2);
    });

    refresh.resolve(latest);
    await vi.waitFor(async () => {
      await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(latest);
    });
    expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(2);
  });

  it("does not let an obsolete first catalog load replace a newer catalog", async () => {
    const cfg = {} as OpenClawConfig;
    const obsolete = [createModel("openai", "gpt-5.4")];
    const latest = [createModel("openai", "gpt-5.5")];
    const firstLoad = createDeferred<ModelCatalogEntry[]>();
    const secondLoad = createDeferred<ModelCatalogEntry[]>();
    mocks.loadModelCatalog
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValueOnce(secondLoad.promise);

    const firstResult = loadGatewayModelCatalog({ getConfig: () => cfg });
    await vi.waitFor(() => {
      expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(1);
    });

    markGatewayModelCatalogStale();
    const secondResult = loadGatewayModelCatalog({ getConfig: () => cfg });
    await vi.waitFor(() => {
      expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(2);
    });

    secondLoad.resolve(latest);
    await expect(secondResult).resolves.toEqual(latest);

    firstLoad.resolve(obsolete);
    await expect(firstResult).resolves.toEqual(obsolete);
    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(latest);
    expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(2);
  });

  it("keeps the prior catalog retryable when core catalog loading reports an empty result", async () => {
    const cfg = {} as OpenClawConfig;
    const initial = [createModel("openai", "gpt-5.4")];
    const refresh = createDeferred<ModelCatalogEntry[]>();
    const retry = createDeferred<ModelCatalogEntry[]>();
    mocks.loadModelCatalog
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(async (params: LoadModelCatalogMockParams) => {
        const catalog = await refresh.promise;
        params.onRetryableResult?.("empty");
        return catalog;
      })
      .mockReturnValueOnce(retry.promise);

    await loadGatewayModelCatalog({ getConfig: () => cfg });
    await flushMicrotasks();
    markGatewayModelCatalogStale();
    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(initial);
    await vi.waitFor(() => {
      expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(2);
    });

    refresh.resolve([]);
    await flushMicrotasks();

    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(initial);
    await vi.waitFor(() => {
      expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(3);
    });
  });

  it("keeps the prior catalog retryable when a shared core load returns empty without a retry signal", async () => {
    const cfg = {} as OpenClawConfig;
    const initial = [createModel("openai", "gpt-5.4")];
    const retry = createDeferred<ModelCatalogEntry[]>();
    mocks.loadModelCatalog
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(retry.promise);

    await loadGatewayModelCatalog({ getConfig: () => cfg });
    await flushMicrotasks();
    markGatewayModelCatalogStale();
    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(initial);
    await vi.waitFor(() => {
      expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(2);
    });

    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(initial);
    await vi.waitFor(() => {
      expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(3);
    });
  });

  it("keeps the prior catalog retryable when core catalog loading reports an error result", async () => {
    const cfg = {} as OpenClawConfig;
    const initial = [createModel("openai", "gpt-5.4")];
    const retry = createDeferred<ModelCatalogEntry[]>();
    mocks.loadModelCatalog
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(async (params: LoadModelCatalogMockParams) => {
        params.onRetryableResult?.("error");
        return [];
      })
      .mockReturnValueOnce(retry.promise);

    await loadGatewayModelCatalog({ getConfig: () => cfg });
    await flushMicrotasks();
    markGatewayModelCatalogStale();
    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(initial);
    await vi.waitFor(() => {
      expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(2);
    });

    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(initial);
    await vi.waitFor(() => {
      expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(3);
    });

    const refreshed = [createModel("openai", "gpt-5.5")];
    retry.resolve(refreshed);
    await vi.waitFor(async () => {
      await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(refreshed);
    });
    expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(3);
  });

  it("keeps serving the prior catalog and retries after a stale refresh fails", async () => {
    const cfg = {} as OpenClawConfig;
    const initial = [createModel("openai", "gpt-5.4")];
    const retry = [createModel("openai", "gpt-5.5")];
    const failedRefresh = createDeferred<ModelCatalogEntry[]>();
    const retryRefresh = createDeferred<ModelCatalogEntry[]>();
    mocks.loadModelCatalog
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(failedRefresh.promise)
      .mockReturnValueOnce(retryRefresh.promise);

    await loadGatewayModelCatalog({ getConfig: () => cfg });
    await flushMicrotasks();
    markGatewayModelCatalogStale();
    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(initial);
    await vi.waitFor(() => {
      expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(2);
    });

    failedRefresh.reject(new Error("refresh failed"));
    await flushMicrotasks();

    await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(initial);
    await vi.waitFor(() => {
      expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(3);
    });
    retryRefresh.resolve(retry);
    await vi.waitFor(async () => {
      await expect(loadGatewayModelCatalog({ getConfig: () => cfg })).resolves.toEqual(retry);
    });

    expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(3);
  });
});
