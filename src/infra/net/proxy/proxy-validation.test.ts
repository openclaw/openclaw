import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apnsHttp2 from "../../push-apns-http2.js";
import { fetchWithRuntimeDispatcher } from "../runtime-fetch.js";
import { createHttp1ProxyAgent } from "../undici-runtime.js";
import { runProxyValidation } from "./proxy-validation.js";

vi.mock("../runtime-fetch.js", () => ({ fetchWithRuntimeDispatcher: vi.fn() }));
vi.mock("../undici-runtime.js", () => ({ createHttp1ProxyAgent: vi.fn() }));

describe("proxy validation", () => {
  const tempDirs: string[] = [];
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
    vi.mocked(createHttp1ProxyAgent).mockReturnValue({
      close: vi.fn(async () => undefined),
    } as unknown as ReturnType<typeof createHttp1ProxyAgent>);
    vi.mocked(fetchWithRuntimeDispatcher).mockResolvedValue(new Response(null, { status: 200 }));
    vi.spyOn(apnsHttp2, "probeApnsHttp2ReachabilityViaProxy").mockResolvedValue({
      status: 403,
      body: "",
      responseHeaders: { "apns-id": "00000000-0000-0000-0000-000000000000" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeTempCa(contents = "proxy-ca"): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-validation-ca-"));
    tempDirs.push(dir);
    const caFile = path.join(dir, "proxy-ca.pem");
    writeFileSync(caFile, contents, "utf8");
    return caFile;
  }

  function expectFetchThroughProxy(uri: string, proxyTls?: { ca: string }) {
    expect(createHttp1ProxyAgent).toHaveBeenCalledWith(
      { uri, ...(proxyTls ? { proxyTls } : {}) },
      5000,
    );
    expect(fetchWithRuntimeDispatcher).toHaveBeenCalledWith("https://example.com/", {
      dispatcher: expect.anything(),
      redirect: "manual",
    });
  }

  it("preserves the validated response when discarded body cancellation rejects", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    const cancel = vi.fn(() => {
      throw new Error("proxy response cancellation failed");
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("validated"));
      },
      cancel,
    });
    const close = vi.fn(async () => undefined);
    vi.mocked(createHttp1ProxyAgent).mockReturnValue({ close } as unknown as ReturnType<
      typeof createHttp1ProxyAgent
    >);
    vi.mocked(fetchWithRuntimeDispatcher).mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "x-proxy-result": "validated" },
      }),
    );
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const result = await runProxyValidation({
        proxyUrlOverride: "http://proxy.example:3128",
        allowedUrls: ["https://example.com/"],
        deniedUrls: [],
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
      expect(unhandledRejections).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      expect(process.listeners("unhandledRejection")).not.toContain(onUnhandledRejection);
    }
  });

  it("honors an explicit opt-out for an environment proxy URL", async () => {
    const result = await runProxyValidation({
      config: { enabled: false },
      env: { OPENCLAW_PROXY_URL: "http://env-proxy.example:3128" },
    });

    expect(fetchWithRuntimeDispatcher).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      config: {
        enabled: false,
        proxyUrl: "http://env-proxy.example:3128",
        source: "env",
        errors: ["proxy validation is disabled by proxy.enabled=false"],
      },
      checks: [],
    });
  });

  it("rejects unsupported proxy URL protocols before probing", async () => {
    const result = await validate({ config: { proxyUrl: "socks5://proxy.example:1080" } });
    expect(fetchWithRuntimeDispatcher).not.toHaveBeenCalled();
    expect(result.config.errors).toEqual(["proxyUrl must use http:// or https://"]);
  });

  it("reports disabled proxy config as an actionable validation problem", async () => {
    const result = await validate({ config: {} });
    expect(fetchWithRuntimeDispatcher).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      config: {
        enabled: false,
        source: "disabled",
        errors: ["proxy validation requires proxy.proxyUrl, OPENCLAW_PROXY_URL, or --proxy-url"],
      },
      checks: [],
    });
  });

  it("fails the default loopback denied canary on successful ambiguous responses", async () => {
    vi.mocked(fetchWithRuntimeDispatcher).mockResolvedValue(new Response(null, { status: 204 }));
    const result = await validate({ deniedUrls: undefined });

    expectCheck(result, {
      kind: "denied",
      ok: false,
      status: 204,
      error: "Denied loopback canary returned HTTP 204 without the validation token",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/),
    });
  });

  it("passes the default loopback denied canary when the proxy returns a denial response", async () => {
    vi.mocked(fetchWithRuntimeDispatcher).mockResolvedValue(new Response(null, { status: 403 }));
    const result = await validate({ deniedUrls: undefined });

    expectCheck(result, {
      kind: "denied",
      ok: true,
      status: 403,
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/),
    });
  });

  it("fails denied checks when the destination returns HTTP 403", async () => {
    vi.mocked(fetchWithRuntimeDispatcher).mockResolvedValue(new Response(null, { status: 403 }));
    const result = await validate({ deniedUrls: ["http://127.0.0.1/"] });
    expectCheck(result, {
      kind: "denied",
      url: "http://127.0.0.1/",
      ok: false,
      status: 403,
      error: "Denied destination returned HTTP 403; expected the proxy to block the connection",
    });
  });

  it("fails custom denied checks on ambiguous transport errors", async () => {
    vi.mocked(fetchWithRuntimeDispatcher).mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await validate({ deniedUrls: ["https://example.com/closed"] });
    expectCheck(result, {
      kind: "denied",
      url: "https://example.com/closed",
      ok: false,
      error: "Denied destination failed without a verifiable proxy-deny signal: ECONNREFUSED",
    });
  });

  it("fails invalid custom denied URLs before probing", async () => {
    const result = await validate({ deniedUrls: ["not a url"] });
    expect(fetchWithRuntimeDispatcher).not.toHaveBeenCalled();
    expectCheck(result, {
      kind: "denied",
      url: "not a url",
      ok: false,
      error: "Invalid denied destination URL",
    });
  });

  it("fails validation when a denied destination succeeds", async () => {
    const result = await runProxyValidation({
      config: {
        proxyUrl: "http://127.0.0.1:3128",
      },
      env: {},
      allowedUrls: ["https://example.com/"],
      deniedUrls: ["http://127.0.0.1/"],
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([
      {
        kind: "allowed",
        url: "https://example.com/",
        ok: true,
        status: 200,
      },
      {
        kind: "denied",
        url: "http://127.0.0.1/",
        ok: false,
        status: 200,
        error: "Denied destination returned HTTP 200; expected the proxy to block the connection",
      },
    ]);
  });

  it("adds an APNs reachability check when requested", async () => {
    const result = await validate({
      apnsReachability: true,
      apnsAuthority,
      timeoutMs: 1234,
    });

    expect(fetchWithRuntimeDispatcher).not.toHaveBeenCalled();
    expect(apnsHttp2.probeApnsHttp2ReachabilityViaProxy).toHaveBeenCalledWith({
      proxyUrl,
      authority: apnsAuthority,
      timeoutMs: 1234,
    });
    expect(result).toEqual({
      ok: true,
      config: {
        enabled: true,
        proxyUrl,
        source: "config",
        errors: [],
      },
      checks: [{ kind: "apns", url: apnsAuthority, ok: true, status: 403 }],
    });
  });

  it("passes CLI proxy CA file contents to validation checks", async () => {
    const caFile = writeTempCa("cli-proxy-ca");
    const result = await validate({
      proxyUrlOverride: "https://proxy.example:8443",
      proxyCaFileOverride: caFile,
      allowedUrls: ["https://example.com/"],
      apnsReachability: true,
    });

    expect(result.ok).toBe(true);
    expectFetchThroughProxy("https://proxy.example:8443", { ca: "cli-proxy-ca" });
    expect(apnsHttp2.probeApnsHttp2ReachabilityViaProxy).toHaveBeenCalledWith({
      proxyUrl: "https://proxy.example:8443",
      authority: apnsAuthority,
      timeoutMs: 5000,
      proxyTls: { ca: "cli-proxy-ca" },
    });
  });

  it("does not inherit configured proxy CA files for explicit proxy URL validation", async () => {
    const configCaFile = writeTempCa("stale-config-proxy-ca");
    const result = await validate({
      proxyUrlOverride: "https://override-proxy.example:8443",
      config: {
        proxyUrl: "https://config-proxy.example:8443",
        tls: { caFile: configCaFile },
      },
      allowedUrls: ["https://example.com/"],
    });

    expect(result.ok).toBe(true);
    expect(result.config.proxyCaFile).toBeUndefined();
    expectFetchThroughProxy("https://override-proxy.example:8443");
  });

  it("fails closed before probing when proxy CA file cannot be loaded", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-validation-missing-ca-"));
    tempDirs.push(dir);
    const result = await validate({
      proxyUrlOverride: "https://proxy.example:8443",
      proxyCaFileOverride: path.join(dir, "missing.pem"),
      allowedUrls: ["https://example.com/"],
    });

    expect(fetchWithRuntimeDispatcher).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.config.errors).toEqual([
      expect.stringContaining("proxy CA file could not be read"),
    ]);
    expect(result.checks).toEqual([]);
  });

  it("accepts APNs 403 reachability with InvalidProviderToken when apns-id is unavailable", async () => {
    vi.mocked(apnsHttp2.probeApnsHttp2ReachabilityViaProxy).mockResolvedValue({
      status: 403,
      body: JSON.stringify({ reason: "InvalidProviderToken" }),
      responseHeaders: {},
    });
    const result = await validate({ apnsReachability: true });
    expectCheck(result, { kind: "apns", url: apnsAuthority, ok: true, status: 403 });
  });

  it("fails APNs reachability when bare 403 has no APNs proof", async () => {
    vi.mocked(apnsHttp2.probeApnsHttp2ReachabilityViaProxy).mockResolvedValue({
      status: 403,
      body: "",
      responseHeaders: {},
    });
    const result = await validate({ apnsReachability: true });
    expectCheck(result, {
      kind: "apns",
      url: apnsAuthority,
      ok: false,
      error: expect.stringContaining("InvalidProviderToken"),
    });
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
