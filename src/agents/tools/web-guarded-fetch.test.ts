// Web fetch transport wrapper tests cover timeout normalization and release handling.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { fetchWithAppNetworkTransport } from "../../infra/net/fetch-transport.js";
import {
  fetchWithWebToolsNetworkGuard,
  withSelfHostedWebToolsEndpoint,
  withStrictWebToolsEndpoint,
  withTrustedWebToolsEndpoint,
} from "./web-guarded-fetch.js";

vi.mock("../../infra/net/fetch-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/net/fetch-guard.js")>();
  return {
    ...actual,
    fetchWithSsrFGuard: vi.fn(),
  };
});

vi.mock("../../infra/net/fetch-transport.js", () => ({
  fetchWithAppNetworkTransport: vi.fn(),
}));

function firstAppFetchCall(): Record<string, unknown> {
  const call = vi.mocked(fetchWithAppNetworkTransport).mock.calls[0]?.[0];
  if (!call || typeof call !== "object") {
    throw new Error("Expected app transport fetch call");
  }
  return call as Record<string, unknown>;
}

function firstGuardedFetchCall(): Record<string, unknown> {
  const call = vi.mocked(fetchWithSsrFGuard).mock.calls[0]?.[0];
  if (!call || typeof call !== "object") {
    throw new Error("Expected guarded fetch call");
  }
  return call as Record<string, unknown>;
}

function mockAppTransportResponse() {
  const release = vi.fn(async () => undefined);
  vi.mocked(fetchWithAppNetworkTransport).mockResolvedValue({
    response: new Response("ok", { status: 200 }),
    finalUrl: "https://example.com",
    release,
  });
  return { release };
}

function mockGuardedFetchResponse() {
  const release = vi.fn(async () => undefined);
  vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
    response: new Response("ok", { status: 200 }),
    finalUrl: "https://example.com",
    release,
  });
  return { release };
}

describe("web-guarded-fetch", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses the app transport for app-owned web tool fetches", async () => {
    mockAppTransportResponse();

    await fetchWithWebToolsNetworkGuard({ url: "https://public.example" });

    expect(firstAppFetchCall().url).toBe("https://public.example");
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("uses guarded fetch for trusted, self-hosted, and strict endpoint wrappers", async () => {
    mockGuardedFetchResponse();

    await withTrustedWebToolsEndpoint({ url: "https://trusted.example" }, async () => undefined);
    await withSelfHostedWebToolsEndpoint({ url: "http://127.0.0.1:8080" }, async () => undefined);
    await withStrictWebToolsEndpoint({ url: "https://strict.example" }, async () => undefined);

    expect(vi.mocked(fetchWithSsrFGuard).mock.calls.map(([params]) => params.url)).toEqual([
      "https://trusted.example",
      "http://127.0.0.1:8080",
      "https://strict.example",
    ]);
    expect(vi.mocked(fetchWithSsrFGuard).mock.calls.map(([params]) => params.mode)).toEqual([
      "trusted_env_proxy",
      "trusted_env_proxy",
      "strict",
    ]);
    expect(fetchWithAppNetworkTransport).not.toHaveBeenCalled();
  });

  it("normalizes string timeouts before guarded dispatch", async () => {
    mockGuardedFetchResponse();

    await withStrictWebToolsEndpoint(
      { url: "https://example.com", timeoutSeconds: "7" as never },
      async () => undefined,
    );
    expect(firstGuardedFetchCall().timeoutMs).toBe(7000);

    vi.clearAllMocks();
    mockGuardedFetchResponse();

    await withStrictWebToolsEndpoint(
      {
        url: "https://example.com",
        timeoutMs: "2500" as never,
        timeoutSeconds: "7" as never,
      },
      async () => undefined,
    );
    expect(firstGuardedFetchCall().timeoutMs).toBe(2500);
  });

  it("keeps trusted endpoint redirects on the initial hostname allowlist", async () => {
    mockGuardedFetchResponse();

    await withTrustedWebToolsEndpoint(
      {
        url: "https://TRUSTED.example./api",
      },
      async () => undefined,
    );

    expect(firstGuardedFetchCall().policy).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
      hostnameAllowlist: ["trusted.example."],
    });
  });

  it("caps oversized timeoutSeconds before guarded dispatch", async () => {
    mockGuardedFetchResponse();

    await withStrictWebToolsEndpoint(
      { url: "https://example.com", timeoutSeconds: Number.MAX_SAFE_INTEGER },
      async () => undefined,
    );

    expect(firstGuardedFetchCall().timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("releases the guarded fetch after the endpoint callback", async () => {
    const { release } = mockGuardedFetchResponse();

    await withStrictWebToolsEndpoint({ url: "https://example.com" }, async () => "done");

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed timeouts before transport dispatch", async () => {
    await expect(
      withStrictWebToolsEndpoint(
        { url: "https://example.com", timeoutMs: "2.5" as never },
        async () => undefined,
      ),
    ).rejects.toThrow("timeoutMs must be a positive integer");
    await expect(
      withStrictWebToolsEndpoint(
        { url: "https://example.com", timeoutSeconds: -1 },
        async () => undefined,
      ),
    ).rejects.toThrow("timeoutSeconds must be a positive integer");
    expect(fetchWithAppNetworkTransport).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});
