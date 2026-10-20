import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard, GUARDED_FETCH_MODE } from "../../infra/net/fetch-guard.js";
import {
  withSelfHostedWebToolsEndpoint,
  withStrictWebToolsEndpoint,
  withTrustedWebToolsEndpoint,
} from "./web-guarded-fetch.js";

vi.mock("../../infra/net/fetch-guard.js", () => {
  const GUARDED_FETCH_MODELocal = {
    STRICT: "strict",
    TRUSTED_ENV_PROXY: "trusted_env_proxy",
  } as const;
  return {
    GUARDED_FETCH_MODE: GUARDED_FETCH_MODELocal,
    fetchWithSsrFGuard: vi.fn(),
    withStrictGuardedFetchMode: (params: Record<string, unknown>) => ({
      ...params,
      mode: GUARDED_FETCH_MODELocal.STRICT,
    }),
    withTrustedEnvProxyGuardedFetchMode: (params: Record<string, unknown>) => ({
      ...params,
      mode: GUARDED_FETCH_MODELocal.TRUSTED_ENV_PROXY,
    }),
  };
});

function firstFetchCall() {
  const call = vi.mocked(fetchWithSsrFGuard).mock.calls[0]?.[0];
  if (!call || typeof call !== "object") {
    throw new Error("Expected guarded fetch call");
  }
  return call;
}

const strictFetch = (params: Parameters<typeof withStrictWebToolsEndpoint>[0]) =>
  withStrictWebToolsEndpoint(params, async () => undefined);

describe("web-guarded-fetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });
  });

  it("uses a host-scoped fake-IP SSRF policy for trusted web tools endpoints", async () => {
    await withTrustedWebToolsEndpoint({ url: "https://example.com" }, async () => undefined);
    expect(firstFetchCall()).toMatchObject({
      url: "https://example.com",
      mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
    });
    expect(firstFetchCall().policy).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
      hostnameAllowlist: ["example.com"],
    });
  });

  it("uses private-network policy only for self-hosted web tools endpoints", async () => {
    await withSelfHostedWebToolsEndpoint({ url: "http://127.0.0.1:8080" }, async () => undefined);
    expect(firstFetchCall()).toMatchObject({
      url: "http://127.0.0.1:8080",
      policy: {
        dangerouslyAllowPrivateNetwork: true,
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
      },
      mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
    });
  });

  it("keeps strict endpoint policy unchanged", async () => {
    await strictFetch({ url: "https://example.com" });
    expect(firstFetchCall()).toMatchObject({
      url: "https://example.com",
      mode: GUARDED_FETCH_MODE.STRICT,
    });
    expect(firstFetchCall().policy).toBeUndefined();
  });

  it("normalizes string timeouts before guarded fetch dispatch", async () => {
    await strictFetch({ url: "https://example.com", timeoutSeconds: "7" as never });
    expect(firstFetchCall().timeoutMs).toBe(7000);

    vi.clearAllMocks();

    await strictFetch({
      url: "https://example.com",
      timeoutMs: "2500" as never,
      timeoutSeconds: "7" as never,
    });
    expect(firstFetchCall().timeoutMs).toBe(2500);
  });

  it("rejects malformed timeouts before guarded fetch dispatch", async () => {
    await expect(
      strictFetch({ url: "https://example.com", timeoutMs: "2.5" as never }),
    ).rejects.toThrow("timeoutMs must be a positive integer");
    await expect(strictFetch({ url: "https://example.com", timeoutSeconds: -1 })).rejects.toThrow(
      "timeoutSeconds must be a positive integer",
    );
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});
