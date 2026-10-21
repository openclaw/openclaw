import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as ProviderRuntime from "../plugins/provider-runtime.js";
import { loadProviderUsageSummary } from "./provider-usage.load.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

const mocks = vi.hoisted(() => {
  const dispatcher = { dispatch: () => true };
  const fetch = vi.fn();
  return {
    resolve: vi.fn<typeof ProviderRuntime.resolveProviderUsageSnapshotWithPlugin>(),
    dispatcher,
    proxyAgent: vi.fn(() => dispatcher),
    runtime: vi.fn(() => ({ FormData: globalThis.FormData, fetch })),
    fetch,
  };
});

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
}));

// mock-isolation: Capture proxy dispatch without opening real network connections.
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

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockResolvedValue(null);
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
  const result = await loadProviderUsageSummary({
    now: usageNow,
    env: {},
    auth: [{ ...auth, hookProvider: "codex" }],
  });
  expect(result).toEqual(expected);
  expect(mocks.resolve.mock.calls).toMatchObject([[{ provider: "codex", context: auth }]]);
});

it.each([false, true])("routes plugin fetch with explicit override=%s", async (explicit) => {
  const fetch = vi.fn(async () => new Response("{}"));
  mocks.fetch.mockResolvedValueOnce(new Response("{}"));
  mocks.resolve.mockImplementationOnce(async ({ context }) => {
    await context.fetchFn(url);
    return snapshot;
  });
  expect(await loadProviderUsageSummary({ ...options, ...(explicit ? { fetch } : {}) })).toEqual(
    expected,
  );
  if (explicit) {
    expect(fetch).toHaveBeenCalledOnce();
    for (const mock of [mocks.runtime, mocks.proxyAgent, mocks.fetch]) {
      expect(mock).not.toHaveBeenCalled();
    }
    return;
  }
  expect(mocks.proxyAgent.mock.calls).toEqual([
    [{ httpsProxy: "http://proxy.test:8080" }, undefined, env],
  ]);
  expect(mocks.fetch.mock.calls).toMatchObject([[url, { dispatcher: mocks.dispatcher }]]);
});
