import fs from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  disposeStoreRemoteFixtures,
  withStoreRemoteFixture,
  wrapStoreSaveRemoteMedia,
} from "./store-network.test-support.js";
import { saveMediaSource } from "./store.js";

const saveRemoteMediaMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const requestHeaders = { Authorization: "Bearer secret", Accept: "text/plain" };
const stored = { id: "stored.txt", path: "/tmp/stored.txt", size: 6, contentType: "text/plain" };
const contentResponse = (text: string, contentType = "text/plain") =>
  new Response(text, { status: 200, headers: { "content-type": contentType } });

vi.mock("./fetch.js", () => ({
  saveRemoteMedia: saveRemoteMediaMock,
}));
vi.mock("../infra/net/runtime-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/net/runtime-fetch.js")>()),
  fetchWithRuntimeDispatcherOrMockedGlobal: runtimeFetchMock,
}));

async function useActualSaveRemoteMedia(url: string): Promise<void> {
  const actual = await vi.importActual<typeof import("./fetch.js")>("./fetch.js");
  const save = wrapStoreSaveRemoteMedia(actual.saveRemoteMedia);
  saveRemoteMediaMock.mockImplementationOnce((options) =>
    withStoreRemoteFixture(
      { url, lookupFn: async () => [{ address: "93.184.216.34", family: 4 }] },
      () => save(options),
    ),
  );
}

describe("media store remote sources", () => {
  let testState: OpenClawTestState;

  beforeAll(async () => {
    testState = await createOpenClawTestState({ layout: "state-only" });
  });

  beforeEach(() => {
    saveRemoteMediaMock.mockReset();
    runtimeFetchMock.mockReset();
  });

  afterAll(async () => {
    disposeStoreRemoteFixtures();
    await testState.cleanup();
  });

  it("forwards the source contract to guarded fetch and keeps the SavedMedia shape", async () => {
    const source = "https://example.com/files/report.txt";
    saveRemoteMediaMock.mockResolvedValueOnce({ ...stored, fileName: "report.txt" });

    const saved = await saveMediaSource(source, requestHeaders, "remote", 1234);

    expect(saveRemoteMediaMock).toHaveBeenCalledWith({
      url: source,
      requestInit: { headers: requestHeaders },
      filePathHint: source,
      maxBytes: 1234,
      maxRedirects: 5,
      fetchImpl: expect.any(Function),
      responseHeaderTimeoutMs: 30_000,
      readIdleTimeoutMs: 30_000,
      originalFilename: "_.txt",
      subdir: "remote",
    });
    expect(saved).toStrictEqual(stored);
  });

  it("rejects unsafe subdirectories before starting a remote fetch", async () => {
    await expect(
      saveMediaSource("https://example.com/file.bin", undefined, "../outside"),
    ).rejects.toThrow("unsafe media subdir");
    expect(saveRemoteMediaMock).not.toHaveBeenCalled();
  });

  it("preserves an unmapped URL suffix through the canonical public flow", async () => {
    const url = "https://example.com/files/report.custom?token=secret";
    await useActualSaveRemoteMedia(url);
    runtimeFetchMock.mockResolvedValueOnce(contentResponse("custom", "application/x-custom"));

    const saved = await saveMediaSource(url, undefined, "remote", 1024);

    expect(saved.id).toMatch(/^[a-f0-9-]{36}\.custom$/);
    expect(saved.id).not.toContain("report");
    await expect(fs.readFile(saved.path, "utf8")).resolves.toBe("custom");
  });

  it.each([true, false])("reports HTTP failures (unfinished body=%s)", async (unfinished) => {
    const media = await vi.importActual<typeof import("./fetch.js")>("./fetch.js");
    const transport = await vi.importActual<typeof import("../infra/net/runtime-fetch.js")>(
      "../infra/net/runtime-fetch.js",
    );
    saveRemoteMediaMock.mockImplementationOnce(wrapStoreSaveRemoteMedia(media.saveRemoteMedia));
    runtimeFetchMock.mockImplementation(transport.fetchWithRuntimeDispatcher);
    const responseClosed = createDeferredCore<boolean>();
    const socketClosed = createDeferredCore();
    const body = "synthetic upstream unavailable";
    await withEnvAsync({ no_proxy: "127.0.0.1" }, () =>
      withServer(
        (request, response) => {
          if (unfinished) {
            response.once("close", () => responseClosed.resolve(response.writableFinished));
            request.socket.once("close", () => socketClosed.resolve());
          }
          response.writeHead(503, "Service Unavailable", { "content-type": "text/plain" });
          response[unfinished ? "write" : "end"](body);
        },
        async (url) => {
          const matchedUrls: string[] = [];
          const operation = unfinished
            ? withStoreRemoteFixture({ url, onMatch: (matched) => matchedUrls.push(matched) }, () =>
                saveMediaSource(url, undefined, "real-http-error", 64),
              )
            : media.readRemoteMediaBuffer({
                url,
                fetchImpl: transport.fetchWithRuntimeDispatcher,
                ssrfPolicy: { allowedOrigins: [url] },
              });
          const failure = await operation.catch((error: unknown) => error);
          expect(failure).toMatchObject({
            name: "MediaFetchError",
            code: "http_error",
            status: 503,
            message: `Failed to fetch media from ${url}: HTTP 503 Service Unavailable${unfinished ? "" : `; body: ${body}`}`,
          });
          if (unfinished) {
            expect(matchedUrls).toEqual([url]);
            // Observe closure before withServer's cleanup can close the socket itself.
            const [finished] = await Promise.all([responseClosed.promise, socketClosed.promise]);
            expect(finished).toBe(false);
            await expect(
              fs.readdir(testState.statePath("media", "real-http-error")),
            ).resolves.toEqual([]);
          }
        },
      ),
    );
  });

  it("keeps redirect cancellation and cross-origin header stripping in the guard", async () => {
    await useActualSaveRemoteMedia("https://example.com/start");
    const cancel = vi.fn();
    runtimeFetchMock
      .mockResolvedValueOnce(
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status: 302,
          headers: { location: "https://cdn.example.com/asset.txt" },
        }),
      )
      .mockResolvedValueOnce(contentResponse("redirected"));

    const saved = await saveMediaSource("https://example.com/start", requestHeaders);

    expect(cancel).toHaveBeenCalledOnce();
    expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
    const secondInit = runtimeFetchMock.mock.calls[1]?.[1] as RequestInit;
    const { authorization = null, accept } = Object.fromEntries(new Headers(secondInit.headers));
    expect({ authorization, accept }).toEqual({ authorization: null, accept: "text/plain" });
    await expect(fs.readFile(saved.path, "utf8")).resolves.toBe("redirected");
    const expectedMode = process.platform === "win32" ? 0o666 : 0o644 & ~process.umask();
    expect((await fs.stat(saved.path)).mode & 0o777).toBe(expectedMode);
  });
});
