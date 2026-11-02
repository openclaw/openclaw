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
  const download = (overrides: Partial<Parameters<typeof downloadGeneratedVideoAsset>[0]>) =>
    downloadGeneratedVideoAsset({
      url: "http://93.184.216.34/video.mp4",
      timeoutMs: 1_000,
      defaultTimeoutMs: 1_000,
      fetchFn: fetch,
      provider: "example",
      label: "Example generated video download",
      requestFailedMessage: "Example generated video download failed",
      ...overrides,
    });
  const videoFetch = (init?: ResponseInit) =>
    vi.fn<typeof fetch>().mockResolvedValue(new Response("synthetic video", init));
  const videoResponse = (body: BodyInit, mime = "video/mp4") =>
    new Response(body, { headers: { "content-type": mime } });
  function respond(response: Response, release?: () => Promise<void>) {
    return async () => ({ response, release });
  }
  // Wrapping the mock exercises production DNS validation instead of the mocked-fetch shortcut.
  function withDns(mock: typeof fetch): typeof fetch {
    return (...args) => mock(...args);
  }

  it.each(["http://127.0.0.1/video.mp4", "http://169.254.169.254/video.mp4"])(
    "blocks private default-download URL %s before connecting",
    async (url) => {
      const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error("unguarded download"));
      await expect(download({ url, fetchFn })).rejects.toMatchObject({ name: "SsrFBlockedError" });
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
    const fetchMock = videoFetch();
    await expect(
      download({ url: "http://result.example/video.mp4", fetchFn: withDns(fetchMock) }),
    ).rejects.toMatchObject({ name: "SsrFBlockedError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses configured result transport without admitting private result URLs", async () => {
    const dispatcherPolicy = {
      mode: "explicit-proxy",
      proxyUrl: "http://proxy.example:8080",
    } as const;
    vi.mocked<LookupFn>(dnsLookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = videoFetch();
    const params = { fetchFn: withDns(fetchMock), dispatcherPolicy };
    const asset = await download({ ...params, url: "https://result.example/video.mp4" });
    expect(asset.buffer).toEqual(Buffer.from("synthetic video"));
    expect(createHttp1ProxyAgent).toHaveBeenCalledWith(
      expect.objectContaining({ uri: dispatcherPolicy.proxyUrl }),
      expect.any(Number),
    );
    await expect(
      download({ ...params, url: "https://169.254.169.254/video.mp4" }),
    ).rejects.toMatchObject({ name: "SsrFBlockedError" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("blocks redirects from public default-download URLs to private targets", async () => {
    const fetchFn = videoFetch({
      status: 302,
      headers: { location: "http://127.0.0.1/private.mp4" },
    });
    await expect(download({ fetchFn })).rejects.toMatchObject({ name: "SsrFBlockedError" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("releases the default guarded download after reading a public result", async () => {
    const fetchFn = videoFetch({ headers: { "content-type": "video/mp4" } });
    const asset = await download({ fetchFn });
    expect(asset.buffer).toEqual(Buffer.from("synthetic video"));
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each([
    { status: 404, maxBytes: 100, error: /Example generated video download failed.*404/ },
    { status: 200, maxBytes: 1, error: /exceeds 1 bytes/ },
  ])(
    "releases rejected default downloads ($status, $maxBytes bytes)",
    async ({ status, maxBytes, error }) => {
      const fetchFn = videoFetch({ status, headers: { "content-type": "video/mp4" } });
      await expect(download({ fetchFn, maxBytes })).rejects.toThrow(error);
      expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    },
  );

  it("preserves deadline-only downloads through a pause longer than the default idle timeout", async () => {
    vi.useFakeTimers();
    const response = videoResponse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          setTimeout(() => controller.close(), 31_000);
        },
      }),
    );
    const result = download({
      timeoutMs: 45_000,
      defaultTimeoutMs: 45_000,
      validateBinaryResponse: true,
      chunkTimeoutMs: 0,
      fetchResponse: respond(response),
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await result).toMatchObject({ buffer: Buffer.from([1, 2, 3]) });
  });

  it("preserves indexed filenames, metadata, and caller-owned response cleanup", async () => {
    const release = vi.fn(async () => undefined);
    const asset = await download({
      index: 2,
      metadata: { sourceUrl: "https://cdn.example/video" },
      fetchResponse: respond(videoResponse(new Uint8Array([1, 2, 3]), "video/webm"), release),
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
    const response = videoResponse(new ReadableStream<Uint8Array>({ cancel }), "application/json");
    await expect(
      download({
        validateBinaryResponse: true,
        fetchResponse: respond(response, release),
      }),
    ).rejects.toThrow("Example generated video download: malformed video response");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
