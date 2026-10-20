// Tests provider usage loading from plugin-provided sources.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProviderUsageSummary } from "./provider-usage.load.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

const mocks = vi.hoisted(() => {
  const dispatcher = { dispatch: () => true };
  const fetch = vi.fn();
  return {
    resolve:
      vi.fn<
        typeof import("../plugins/provider-runtime.js").resolveProviderUsageSnapshotWithPlugin
      >(),
    dispatcher,
    proxyAgent: vi.fn(() => dispatcher),
    runtime: vi.fn(() => ({ FormData: globalThis.FormData, fetch })),
    fetch,
  };
});

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
}));

vi.mock("./net/undici-runtime.js", () => ({
  createHttp1EnvHttpProxyAgent: mocks.proxyAgent,
  loadUndiciRuntimeDeps: mocks.runtime,
}));

vi.mock("../plugins/provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-runtime.js")>()),
  resolveProviderUsageSnapshotWithPlugin: mocks.resolve,
}));

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
function usePluginFetch() {
  mocks.resolve.mockImplementationOnce(async ({ context }) => {
    await context.fetchFn(url);
    return snapshot;
  });
}

describe("provider usage plugin routing", () => {
  beforeEach(() => {
    mocks.proxyAgent.mockClear();
    mocks.runtime.mockClear();
    mocks.fetch.mockReset();
    mocks.resolve.mockReset().mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("unexpected global fetch");
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("routes synthetic usage to the Codex hook with the original OpenAI account context", async () => {
    mocks.resolve.mockResolvedValueOnce(snapshot);
    const auth = { provider: "openai", token: "codex-app-server", authProfileId: "openai:work" };
    expect(
      await loadProviderUsageSummary({
        now: usageNow,
        env: {},
        auth: [{ ...auth, hookProvider: "codex" }],
      }),
    ).toEqual(expected);
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        provider: "codex",
        context: expect.objectContaining(auth),
      }),
    );
  });

  it("routes plugin requests through the environment proxy", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response("{}"));
    usePluginFetch();
    expect(await loadProviderUsageSummary(options)).toEqual(expected);
    expect(mocks.proxyAgent).toHaveBeenCalledExactlyOnceWith(
      { httpsProxy: "http://proxy.test:8080" },
      undefined,
      env,
    );
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(
      url,
      expect.objectContaining({ dispatcher: mocks.dispatcher }),
    );
  });

  it("prefers explicit fetch over the environment proxy", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    usePluginFetch();
    expect(await loadProviderUsageSummary({ ...options, fetch })).toEqual(expected);
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.proxyAgent).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
