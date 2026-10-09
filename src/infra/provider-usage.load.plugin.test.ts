// Tests provider usage loading from plugin-provided sources.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProviderUsageSummary } from "./provider-usage.load.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

const resolveProviderUsageSnapshotWithPluginMock = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/provider-runtime.js").resolveProviderUsageSnapshotWithPlugin>(),
);
const { envDispatcher, createHttp1EnvHttpProxyAgent, loadUndiciRuntimeDeps, undiciFetch } =
  vi.hoisted(() => {
    const envDispatcherLocal = { dispatch: () => true };
    const undiciFetchLocal = vi.fn();
    const loadUndiciRuntimeDepsLocal = vi.fn(() => ({
      FormData: globalThis.FormData,
      fetch: undiciFetchLocal,
    }));

    return {
      envDispatcher: envDispatcherLocal,
      createHttp1EnvHttpProxyAgent: vi.fn(() => envDispatcherLocal),
      loadUndiciRuntimeDeps: loadUndiciRuntimeDepsLocal,
      undiciFetch: undiciFetchLocal,
    };
  });

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
}));

vi.mock("./net/undici-runtime.js", () => ({
  createHttp1EnvHttpProxyAgent,
  loadUndiciRuntimeDeps,
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderUsageSnapshotWithPlugin: resolveProviderUsageSnapshotWithPluginMock,
  };
});

const usageNow = Date.UTC(2026, 0, 7);
const snapshot: ProviderUsageSnapshot = {
  provider: "openai",
  displayName: "OpenAI",
  windows: [{ label: "5h", usedPercent: 9 }],
};
const expected = { updatedAt: usageNow, providers: [snapshot] };
const env = { HTTP_PROXY: "", HTTPS_PROXY: "http://proxy.test:8080" };
const url = "https://chatgpt.com/backend-api/wham/usage";
const options = {
  now: usageNow,
  auth: [{ provider: "openai", token: "codex-token", accountId: "acc-1" }],
  env,
};

describe("provider usage plugin routing", () => {
  beforeEach(() => {
    createHttp1EnvHttpProxyAgent.mockClear();
    loadUndiciRuntimeDeps.mockClear();
    undiciFetch.mockReset();
    resolveProviderUsageSnapshotWithPluginMock.mockReset();
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("unexpected global fetch");
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("routes synthetic usage to the Codex hook with the original OpenAI account context", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce(snapshot);
    expect(
      await loadProviderUsageSummary({
        now: usageNow,
        env: {},
        auth: [
          {
            provider: "openai",
            token: "codex-app-server",
            authProfileId: "openai:work",
            hookProvider: "codex",
          },
        ],
      }),
    ).toEqual(expected);
    expect(resolveProviderUsageSnapshotWithPluginMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        provider: "codex",
        context: expect.objectContaining({
          provider: "openai",
          token: "codex-app-server",
          authProfileId: "openai:work",
        }),
      }),
    );
  });

  it("routes plugin requests through the environment proxy", async () => {
    undiciFetch.mockResolvedValueOnce(new Response("{}"));
    resolveProviderUsageSnapshotWithPluginMock.mockImplementationOnce(async ({ context }) => {
      await context.fetchFn(url);
      return snapshot;
    });
    expect(await loadProviderUsageSummary(options)).toEqual(expected);
    expect(createHttp1EnvHttpProxyAgent).toHaveBeenCalledExactlyOnceWith(
      { httpsProxy: "http://proxy.test:8080" },
      undefined,
      env,
    );
    expect(undiciFetch).toHaveBeenCalledExactlyOnceWith(
      url,
      expect.objectContaining({ dispatcher: envDispatcher }),
    );
  });

  it("prefers explicit fetch over the environment proxy", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    resolveProviderUsageSnapshotWithPluginMock.mockImplementationOnce(async ({ context }) => {
      await context.fetchFn(url);
      return snapshot;
    });
    expect(await loadProviderUsageSummary({ ...options, fetch })).toEqual(expected);
    expect(fetch).toHaveBeenCalledOnce();
    expect(loadUndiciRuntimeDeps).not.toHaveBeenCalled();
    expect(createHttp1EnvHttpProxyAgent).not.toHaveBeenCalled();
    expect(undiciFetch).not.toHaveBeenCalled();
  });
});
