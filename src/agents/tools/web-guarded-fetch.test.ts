import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard, GUARDED_FETCH_MODE } from "../../infra/net/fetch-guard.js";
import {
  fetchWithWebToolsNetworkGuard,
  withStrictWebToolsEndpoint,
  withTrustedWebToolsEndpoint,
} from "./web-guarded-fetch.js";

vi.mock("../../infra/net/fetch-guard.js", () => {
  const GUARDED_FETCH_MODE = {
    STRICT: "strict",
    TRUSTED_ENV_PROXY: "trusted_env_proxy",
  } as const;
  return {
    GUARDED_FETCH_MODE,
    fetchWithSsrFGuard: vi.fn(),
    withStrictGuardedFetchMode: (params: Record<string, unknown>) => ({
      ...params,
      mode: GUARDED_FETCH_MODE.STRICT,
    }),
    withTrustedEnvProxyGuardedFetchMode: (params: Record<string, unknown>) => ({
      ...params,
      mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
    }),
  };
});

describe("web-guarded-fetch", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses trusted SSRF policy for trusted web tools endpoints", async () => {
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await withTrustedWebToolsEndpoint({ url: "https://example.com" }, async () => undefined);

    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com",
        policy: expect.objectContaining({
          dangerouslyAllowPrivateNetwork: true,
          allowRfc2544BenchmarkRange: true,
        }),
        mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
      }),
    );
  });

  it("keeps strict endpoint policy unchanged", async () => {
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await withStrictWebToolsEndpoint({ url: "https://example.com" }, async () => undefined);

    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com",
      }),
    );
    const call = vi.mocked(fetchWithSsrFGuard).mock.calls[0]?.[0];
    expect(call?.policy).toBeUndefined();
    expect(call?.mode).toBe(GUARDED_FETCH_MODE.STRICT);
  });

  it("selects env-proxy dispatcher policy for strict web fetch when proxy env is configured", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await fetchWithWebToolsNetworkGuard({ url: "https://example.com" });

    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com",
        mode: GUARDED_FETCH_MODE.STRICT,
        dispatcherPolicy: { mode: "env-proxy" },
      }),
    );
  });

  it("does not override an explicit dispatcher policy for strict web fetch", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await fetchWithWebToolsNetworkGuard({
      url: "https://example.com",
      dispatcherPolicy: { mode: "direct" },
    });

    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatcherPolicy: { mode: "direct" },
      }),
    );
  });

  it("does not select env-proxy dispatcher when only ALL_PROXY is configured", async () => {
    vi.stubEnv("ALL_PROXY", "socks5://127.0.0.1:7890");
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await fetchWithWebToolsNetworkGuard({ url: "https://example.com" });

    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com",
        mode: GUARDED_FETCH_MODE.STRICT,
      }),
    );
    const call = vi.mocked(fetchWithSsrFGuard).mock.calls[0]?.[0];
    expect(call?.dispatcherPolicy).toBeUndefined();
  });
});
