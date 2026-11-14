import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apnsHttp2 from "../../push-apns-http2.js";
import { fetchWithRuntimeDispatcher } from "../runtime-fetch.js";
import { createHttp1ProxyAgent } from "../undici-runtime.js";
import { useProxyCaFiles } from "./proxy-ca.test-support.js";
import { runProxyValidation } from "./proxy-validation.js";

vi.mock("../runtime-fetch.js", () => ({ fetchWithRuntimeDispatcher: vi.fn() }));
vi.mock("../undici-runtime.js", () => ({ createHttp1ProxyAgent: vi.fn() }));

describe("proxy validation", () => {
  const writeTempCa = useProxyCaFiles();
  const close = vi.fn<() => Promise<void>>();
  const proxyUrl = "http://127.0.0.1:3128";
  const apnsAuthority = "https://api.sandbox.push.apple.com";
  function validate(options: Parameters<typeof runProxyValidation>[0] = {}) {
    return runProxyValidation({
      config: { proxyUrl },
      env: {},
      allowedUrls: [],
      deniedUrls: [],
      ...options,
    });
  }
  function expectCheck(
    result: Awaited<ReturnType<typeof runProxyValidation>>,
    check: (typeof result.checks)[number],
  ) {
    expect(result.ok).toBe(check.ok);
    expect(result.checks).toEqual([check]);
  }

  beforeEach(() => {
    vi.resetAllMocks();
    close.mockResolvedValue(undefined);
    vi.mocked(createHttp1ProxyAgent).mockReturnValue({
      close,
    } as unknown as ReturnType<typeof createHttp1ProxyAgent>);
    vi.mocked(fetchWithRuntimeDispatcher).mockResolvedValue(new Response(null, { status: 200 }));
    vi.spyOn(apnsHttp2, "probeApnsHttp2ReachabilityViaProxy").mockResolvedValue({
      status: 403,
      body: "",
      responseHeaders: { "apns-id": "00000000-0000-0000-0000-000000000000" },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  function expectFetchThroughProxy(uri: string, proxyTls?: { ca: string }, timeoutMs = 5000) {
    expect(createHttp1ProxyAgent).toHaveBeenCalledWith(
      { uri, ...(proxyTls ? { proxyTls } : {}) },
      timeoutMs,
    );
    expect(fetchWithRuntimeDispatcher).toHaveBeenCalledWith("https://example.com/", {
      dispatcher: expect.anything(),
      redirect: "manual",
    });
  }

  it("preserves the validated response when discarded body cancellation rejects", async () => {
    const onUnhandledRejection = vi.fn();
    const cancel = vi.fn(() => {
      throw new Error("proxy response cancellation failed");
    });
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.mocked(fetchWithRuntimeDispatcher).mockResolvedValue(new Response(body, { status: 200 }));
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const result = await validate({
        proxyUrlOverride: "http://proxy.example:3128",
        allowedUrls: ["https://example.com/"],
      });

      expect(result).toMatchObject({
        ok: true,
        checks: [{ kind: "allowed", ok: true, status: 200 }],
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(onUnhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it.each([
    [
      { config: { enabled: false }, env: { OPENCLAW_PROXY_URL: "http://env-proxy.example:3128" } },
      "env",
      "disabled by proxy.enabled=false",
    ],
    [
      { config: { proxyUrl: "socks5://proxy.example:1080" } },
      "config",
      "proxyUrl must use http:// or https://",
    ],
    [{ config: {} }, "disabled", "requires proxy.proxyUrl"],
  ] as const)("rejects invalid configuration %j before probing", async (options, source, error) => {
    expect(await validate(options)).toMatchObject({
      ok: false,
      checks: [],
      config: { source, errors: [expect.stringContaining(error)] },
    });
    expect(fetchWithRuntimeDispatcher).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 204, false, /without the validation token/],
    [undefined, 403, true, undefined],
    ["http://127.0.0.1/", 403, false, /expected the proxy to block the connection/],
    [
      "https://example.com/closed",
      new Error("ECONNREFUSED"),
      false,
      /without a verifiable proxy-deny signal: ECONNREFUSED/,
    ],
    ["not a url", undefined, false, /Invalid denied destination URL/],
  ] as const)("validates denied destination %s with %s", async (url, response, ok, error) => {
    if (response instanceof Error) {
      vi.mocked(fetchWithRuntimeDispatcher).mockRejectedValue(response);
    } else if (response !== undefined) {
      vi.mocked(fetchWithRuntimeDispatcher).mockResolvedValue(
        new Response(null, { status: response }),
      );
    }
    expectCheck(await validate({ deniedUrls: url ? [url] : undefined }), {
      kind: "denied",
      url: url ?? expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/),
      ok,
      ...(typeof response === "number" ? { status: response } : {}),
      ...(error ? { error: expect.stringMatching(error) } : {}),
    });
    if (response === undefined) {
      expect(fetchWithRuntimeDispatcher).not.toHaveBeenCalled();
    }
  });

  it("fails validation when a denied destination succeeds", async () => {
    const result = await validate({
      allowedUrls: ["https://example.com/"],
      deniedUrls: ["http://127.0.0.1/"],
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toMatchObject([
      { kind: "allowed", ok: true, status: 200 },
      { kind: "denied", ok: false, status: 200 },
    ]);
  });

  it.each([true, false])(
    "uses only explicit CA trust with URL overrides (CA=%s)",
    async (explicitCa) => {
      const overrideUrl = "https://override-proxy.example:8443";
      const proxyTls = explicitCa ? { ca: "cli-proxy-ca" } : undefined;
      const timeoutMs = explicitCa ? 1234 : 5000;
      const result = await validate({
        proxyUrlOverride: overrideUrl,
        proxyCaFileOverride: explicitCa ? writeTempCa("cli-proxy-ca") : undefined,
        config: {
          proxyUrl: "https://config-proxy.example:8443",
          tls: { caFile: writeTempCa("stale-config-proxy-ca") },
        },
        allowedUrls: ["https://example.com/"],
        apnsReachability: true,
        timeoutMs: explicitCa ? timeoutMs : undefined,
      });

      expect(result.checks).toEqual([
        { kind: "allowed", url: "https://example.com/", ok: true, status: 200 },
        { kind: "apns", url: apnsAuthority, ok: true, status: 403 },
      ]);
      expectFetchThroughProxy(overrideUrl, proxyTls, timeoutMs);
      expect(apnsHttp2.probeApnsHttp2ReachabilityViaProxy).toHaveBeenCalledWith({
        proxyUrl: overrideUrl,
        authority: apnsAuthority,
        timeoutMs,
        ...(proxyTls ? { proxyTls } : {}),
      });
      if (!explicitCa) {
        expect(result.config.proxyCaFile).toBeUndefined();
      }
    },
  );

  it("fails closed before probing when proxy CA file cannot be loaded", async () => {
    const result = await validate({
      proxyUrlOverride: "https://proxy.example:8443",
      proxyCaFileOverride: writeTempCa(),
      allowedUrls: ["https://example.com/"],
    });

    expect(fetchWithRuntimeDispatcher).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.config.errors).toEqual([
      expect.stringContaining("proxy CA file could not be read"),
    ]);
    expect(result.checks).toEqual([]);
  });

  it.each([
    {
      body: JSON.stringify({ reason: "InvalidProviderToken" }),
      outcome: { ok: true, status: 403 },
    },
    { body: "", outcome: { ok: false, error: expect.stringContaining("InvalidProviderToken") } },
  ])("requires APNs proof without apns-id: $body", async ({ body, outcome }) => {
    vi.mocked(apnsHttp2.probeApnsHttp2ReachabilityViaProxy).mockResolvedValue({
      status: 403,
      body,
      responseHeaders: {},
    });
    const result = await validate({ apnsReachability: true, apnsAuthority });
    expect(fetchWithRuntimeDispatcher).not.toHaveBeenCalled();
    expect(result.config).toEqual({ enabled: true, proxyUrl, source: "config", errors: [] });
    expectCheck(result, { kind: "apns", url: apnsAuthority, ...outcome });
  });

  it("fails APNs reachability when the proxy blocks CONNECT", async () => {
    vi.mocked(apnsHttp2.probeApnsHttp2ReachabilityViaProxy).mockRejectedValue(
      new Error("HTTP/1.1 403 Forbidden"),
    );
    const result = await validate({ apnsReachability: true });
    expectCheck(result, {
      kind: "apns",
      url: apnsAuthority,
      ok: false,
      error: "HTTP/1.1 403 Forbidden",
    });
  });
});
