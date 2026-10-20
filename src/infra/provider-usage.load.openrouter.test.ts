import { once } from "node:events";
import { createServer } from "node:http";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, expect, it, vi } from "vitest";
import openrouterPlugin from "../../extensions/openrouter/index.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadProviderUsageSummary } from "./provider-usage.load.js";

const resolveProviderUsageSnapshotWithPluginMock = vi.hoisted(() => vi.fn());

vi.mock("../plugins/provider-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-runtime.js")>();
  return {
    ...actual,
    resolveProviderUsageSnapshotWithPlugin: resolveProviderUsageSnapshotWithPluginMock,
  };
});

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  resolveProviderUsageSnapshotWithPluginMock.mockReset();
});

it("loads OpenRouter usage through the default loader and dispatcher-aware transport", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: request.url?.endsWith("/credits")
          ? { total_credits: 10, total_usage: 2 }
          : { limit: 10, usage: 2, label: "synthetic" },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("OpenRouter usage fixture did not bind to a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
    const config = {
      models: { providers: { openrouter: { baseUrl, models: [] } } },
    } satisfies OpenClawConfig;
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    resolveProviderUsageSnapshotWithPluginMock.mockImplementationOnce(async ({ context }) => {
      return await provider.fetchUsageSnapshot?.({
        config: context.config,
        env: context.env,
        provider: context.provider,
        token: context.token,
        timeoutMs: context.timeoutMs,
        signal: context.signal,
        fetchFn: context.fetchFn,
      });
    });

    let ambientFetchCalls = 0;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      ambientFetchCalls += 1;
      return nativeFetch(input, init);
    });

    const usage = await loadProviderUsageSummary({
      providers: ["openrouter"],
      auth: [{ provider: "openrouter", token: "synthetic-invalid-proof-token" }],
      config,
      env: {},
      timeoutMs: 15_000,
    });

    expect(usage.providers).toHaveLength(1);
    expect(usage.providers[0]).toMatchObject({
      provider: "openrouter",
      windows: [{ label: "API key budget", usedPercent: 20 }],
      billing: expect.arrayContaining([
        { type: "balance", label: "Account balance", amount: 8, unit: "USD" },
        { type: "spend", label: "Account usage", amount: 2, unit: "USD" },
        { type: "budget", label: "API key budget", used: 2, limit: 10, unit: "USD" },
      ]),
    });
    expect(requests.toSorted()).toEqual(["/api/v1/credits", "/api/v1/key"]);
    expect(ambientFetchCalls).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
