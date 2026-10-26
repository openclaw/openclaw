import { lookup as dnsLookup } from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LookupFn } from "../infra/net/ssrf.js";
import { createHttp1ProxyAgent } from "../infra/net/undici-runtime.js";
import { downloadGeneratedVideoAsset } from "./provider-assets.js";

vi.mock("node:dns/promises", { spy: true });
vi.mock("../infra/net/undici-runtime.js", { spy: true });

describe("downloadGeneratedVideoAsset", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const downloadDefaults = {
    url: "https://cdn.example/video",
    timeoutMs: 1_000,
    defaultTimeoutMs: 1_000,
    fetchFn: fetch,
    provider: "example",
    label: "Example generated video download",
    requestFailedMessage: "Example generated video download failed",
  };

  it.each(["http://127.0.0.1/video.mp4", "http://169.254.169.254/video.mp4"])(
    "blocks private default-download URL %s before connecting",
    async (url) => {
      const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error("unguarded download"));
      await expect(
        downloadGeneratedVideoAsset({ ...downloadDefaults, url, fetchFn }),
      ).rejects.toMatchObject({ name: "SsrFBlockedError" });
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("validates result DNS when an environment proxy is configured", async () => {
    vi.stubEnv("HTTP_PROXY", "http://proxy.example:8080");
    vi.stubEnv("http_proxy", "http://proxy.example:8080");
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "");
    vi.mocked<LookupFn>(dnsLookup).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("synthetic video"));
    // A plain wrapper exercises production DNS validation instead of the mocked-fetch shortcut.
    const fetchFn: typeof fetch = (...args) => fetchMock(...args);
    await expect(
      downloadGeneratedVideoAsset({
        ...downloadDefaults,
        url: "http://result.example/video.mp4",
        fetchFn,
      }),
    ).rejects.toMatchObject({ name: "SsrFBlockedError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses configured result transport without admitting private result URLs", async () => {
    const dispatcherPolicy = {
      mode: "explicit-proxy",
      proxyUrl: "http://proxy.example:8080",
    } as const;
    vi.mocked<LookupFn>(dnsLookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("synthetic video"));
    const fetchFn: typeof fetch = (...args) => fetchMock(...args);
    const params = { ...downloadDefaults, fetchFn, dispatcherPolicy };
    const asset = await downloadGeneratedVideoAsset({
      ...params,
      url: "https://result.example/video.mp4",
    });
    expect(asset.buffer).toEqual(Buffer.from("synthetic video"));
    expect(createHttp1ProxyAgent).toHaveBeenCalledWith(
      expect.objectContaining({ uri: dispatcherPolicy.proxyUrl }),
      expect.any(Number),
    );
    await expect(
      downloadGeneratedVideoAsset({ ...params, url: "https://169.254.169.254/video.mp4" }),
    ).rejects.toMatchObject({ name: "SsrFBlockedError" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("blocks redirects from public default-download URLs to private targets", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private.mp4" } }),
      );
    await expect(
      downloadGeneratedVideoAsset({
        ...downloadDefaults,
        url: "http://93.184.216.34/video.mp4",
        fetchFn,
      }),
    ).rejects.toMatchObject({ name: "SsrFBlockedError" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("releases the default guarded download after reading a public result", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("synthetic video", { headers: { "content-type": "video/mp4" } }),
      );
    const asset = await downloadGeneratedVideoAsset({
      ...downloadDefaults,
      url: "http://93.184.216.34/video.mp4",
      fetchFn,
    });
    expect(asset.buffer).toEqual(Buffer.from("synthetic video"));
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each([
    { status: 404, maxBytes: 100, error: /Example generated video download failed.*404/ },
    { status: 200, maxBytes: 1, error: /exceeds 1 bytes/ },
  ])("releases rejected default downloads ($status, $maxBytes bytes)", async (scenario) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("synthetic video", {
        status: scenario.status,
        headers: { "content-type": "video/mp4" },
      }),
    );
    await expect(
      downloadGeneratedVideoAsset({
        ...downloadDefaults,
        url: "http://93.184.216.34/video.mp4",
        fetchFn,
        maxBytes: scenario.maxBytes,
      }),
    ).rejects.toThrow(scenario.error);
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("preserves deadline-only downloads through a pause longer than the default idle timeout", async () => {
    vi.useFakeTimers();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          setTimeout(() => controller.close(), 31_000);
        },
      }),
      { headers: { "content-type": "video/mp4" } },
    );
    const result = downloadGeneratedVideoAsset({
      ...downloadDefaults,
      timeoutMs: 45_000,
      defaultTimeoutMs: 45_000,
      validateBinaryResponse: true,
      chunkTimeoutMs: 0,
      fetchResponse: async () => ({ response }),
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(await result).toMatchObject({ buffer: Buffer.from([1, 2, 3]) });
  });

  it("preserves indexed filenames, metadata, and caller-owned response cleanup", async () => {
    const release = vi.fn(async () => undefined);
    const asset = await downloadGeneratedVideoAsset({
      ...downloadDefaults,
      index: 2,
      metadata: { sourceUrl: "https://cdn.example/video" },
      fetchResponse: async () => ({
        response: new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "video/webm" },
        }),
        release,
      }),
    });

    expect(asset).toMatchObject({
      buffer: Buffer.from([1, 2, 3]),
      mimeType: "video/webm",
      fileName: "video-3.webm",
      metadata: { sourceUrl: "https://cdn.example/video" },
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cancels rejected binary bodies before releasing caller-owned transport", async () => {
    const cancel = vi.fn();
    const release = vi.fn(async () => undefined);

    await expect(
      downloadGeneratedVideoAsset({
        ...downloadDefaults,
        validateBinaryResponse: true,
        fetchResponse: async () => ({
          response: new Response(new ReadableStream<Uint8Array>({ cancel }), {
            headers: { "content-type": "application/json" },
          }),
          release,
        }),
      }),
    ).rejects.toThrow("Example generated video download: malformed video response");

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
