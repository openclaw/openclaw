import { EnvHttpProxyAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard, GUARDED_FETCH_MODE } from "./fetch-guard.js";

describe("CWE-918: trusted_env_proxy must preserve DNS pinning", () => {
  type LookupFn = NonNullable<Parameters<typeof fetchWithSsrFGuard>[0]["lookupFn"]>;

  const createPublicLookup = (): LookupFn =>
    vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should pass pinned lookup to EnvHttpProxyAgent in trusted_env_proxy mode", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const lookupFn = createPublicLookup();
    let capturedDispatcher: unknown = null;

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = init as RequestInit & { dispatcher?: unknown };
      capturedDispatcher = requestInit.dispatcher;
      return new Response("ok", { status: 200 });
    });

    const result = await fetchWithSsrFGuard({
      url: "https://public.example/resource",
      fetchImpl,
      lookupFn,
      mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(capturedDispatcher).toBeInstanceOf(EnvHttpProxyAgent);
    await result.release();
  });

  it("should still block private IPs even in trusted_env_proxy mode", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const fetchImpl = vi.fn();

    await expect(
      fetchWithSsrFGuard({
        url: "http://169.254.169.254/latest/meta-data/",
        fetchImpl,
        mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should block DNS rebinding via trusted_env_proxy", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    // Simulate DNS rebinding: hostname resolves to private IP
    const rebindLookup = vi.fn(async () => [
      { address: "127.0.0.1", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = vi.fn();

    await expect(
      fetchWithSsrFGuard({
        url: "https://rebind.attacker.com/steal",
        fetchImpl,
        lookupFn: rebindLookup,
        mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
