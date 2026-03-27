import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock, GUARDED_FETCH_MODE } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  GUARDED_FETCH_MODE: {
    STRICT: "strict",
    TRUSTED_ENV_PROXY: "trusted_env_proxy",
  } as const,
}));

vi.mock("../../infra/net/fetch-guard.js", () => ({
  GUARDED_FETCH_MODE,
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  withStrictGuardedFetchMode: (params: Record<string, unknown>) => ({
    ...params,
    mode: GUARDED_FETCH_MODE.STRICT,
  }),
  withTrustedEnvProxyGuardedFetchMode: (params: Record<string, unknown>) => ({
    ...params,
    mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
  }),
}));

type WebGuardedFetchModule = typeof import("./web-guarded-fetch.js");

let withStrictWebToolsEndpoint: WebGuardedFetchModule["withStrictWebToolsEndpoint"];
let withTrustedWebToolsEndpoint: WebGuardedFetchModule["withTrustedWebToolsEndpoint"];

describe("web-guarded-fetch", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ withStrictWebToolsEndpoint, withTrustedWebToolsEndpoint } = await import("./web-guarded-fetch.js"));
    fetchWithSsrFGuardMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses trusted SSRF policy for trusted web tools endpoints", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await withTrustedWebToolsEndpoint({ url: "https://example.com" }, async () => undefined);

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
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
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await withStrictWebToolsEndpoint({ url: "https://example.com" }, async () => undefined);

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com",
      }),
    );
    const call = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(call?.policy).toBeUndefined();
    expect(call?.mode).toBe(GUARDED_FETCH_MODE.STRICT);
  });

  it("forwards explicit strict SSRF policy overrides", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await withStrictWebToolsEndpoint(
      {
        url: "https://example.com",
        policy: { allowRfc2544BenchmarkRange: true },
      },
      async () => undefined,
    );

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com",
        policy: { allowRfc2544BenchmarkRange: true },
        mode: GUARDED_FETCH_MODE.STRICT,
      }),
    );
  });
});
