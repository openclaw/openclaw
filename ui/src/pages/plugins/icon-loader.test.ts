/* @vitest-environment jsdom */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import {
  fetchCatalogIconBlobUrl,
  fetchLinkFaviconBlobUrl,
  fetchPluginIconBlobUrl,
  fetchPluginThemeArtworkBlobUrl,
} from "./icon-loader.ts";

const auth = { settings: { token: "test-token" } };
const fallbackAuth = {
  hello: { auth: { deviceToken: "stale-device-token" } },
  settings: { token: "fallback-token" },
};

function iconParams(overrides: Partial<Parameters<typeof fetchPluginIconBlobUrl>[0]> = {}) {
  return {
    auth,
    resourceBasePath: "",
    gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
    signal: new AbortController().signal,
    pluginId: "test",
    ...overrides,
  };
}

function imageResponse(): Response {
  return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    headers: { "content-type": "image/png" },
  });
}

async function streamResponses(statuses: number[]) {
  let requests = 0;
  const closed = new Set<number>();
  const server = createServer((request, response) => {
    const index = requests++;
    const responseStatus = statuses[index];
    if (responseStatus === undefined) {
      throw new Error(`unexpected icon request: ${index}`);
    }
    request.socket.once("close", () => closed.add(index));
    response.writeHead(responseStatus, { "content-type": "text/plain" });
    response.write("stream remains open");
  });
  onTestFinished(async () => {
    if (!server.listening) {
      return;
    }
    const closing = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await closing;
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return nativeFetch(new URL(requestUrl, baseUrl), init);
  });
  return { closed, requestCount: () => requests };
}

function rejectedResponse(status: number, cancel: () => Promise<void>): Response {
  return new Response(new ReadableStream({ cancel }), { status });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("loads plugin and wire-provided catalog icons through same-origin proxy routes", async () => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi
        .fn()
        .mockReturnValueOnce("blob:plugin-icon")
        .mockReturnValueOnce("blob:catalog-icon")
        .mockReturnValueOnce("blob:link-favicon");
    },
  );
  const fetchMock = vi.fn().mockImplementation(async () => imageResponse());
  vi.stubGlobal("fetch", fetchMock);
  const common = iconParams({ resourceBasePath: "/openclaw" });

  await expect(fetchPluginIconBlobUrl({ ...common, pluginId: "firecrawl" })).resolves.toBe(
    "blob:plugin-icon",
  );
  const iconUrl = "https://cdn.example.test/provider.svg";
  await expect(fetchCatalogIconBlobUrl({ ...common, iconUrl })).resolves.toBe("blob:catalog-icon");
  await expect(fetchLinkFaviconBlobUrl({ ...common, hostname: "docs.example.com" })).resolves.toBe(
    "blob:link-favicon",
  );

  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    "/openclaw/__openclaw__/plugin-icon/firecrawl",
    `/openclaw/__openclaw__/catalog-icon/${encodeURIComponent(iconUrl)}`,
    "/openclaw/__openclaw__/link-favicon/docs.example.com",
  ]);
  expect(
    fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
  ).toEqual(["Bearer test-token", "Bearer test-token", "Bearer test-token"]);
  expect(fetchMock.mock.calls.some(([url]) => url === iconUrl)).toBe(false);
});

it("retries theme artwork misses while deduplicating concurrent callers and refusing non-resource URLs", async () => {
  const fetchMock = vi.fn().mockImplementation(async () => imageResponse());
  vi.stubGlobal("fetch", fetchMock);
  const params = {
    auth,
    resourceBasePath: "/openclaw",
    gatewayUrl: window.location.origin,
    url: "/__openclaw__/plugin-theme-art/test/theme/hat/beret?v=miss",
  };
  await expect(
    Promise.all([fetchPluginThemeArtworkBlobUrl(params), fetchPluginThemeArtworkBlobUrl(params)]),
  ).resolves.toEqual([null, null]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await expect(fetchPluginThemeArtworkBlobUrl(params)).resolves.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(`/openclaw${params.url}`);
  await expect(
    fetchPluginThemeArtworkBlobUrl({ ...params, url: "https://other.test/art.svg" }),
  ).resolves.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await expect(
    fetchPluginThemeArtworkBlobUrl({ ...params, url: params.url.replace("miss", "new") }),
  ).resolves.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("refuses proxy loading when the configured gateway is cross-origin", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    fetchCatalogIconBlobUrl({
      ...iconParams({ gatewayUrl: "wss://remote.example.test" }),
      iconUrl: "https://cdn.example.test/provider.svg",
    }),
  ).resolves.toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  { rejection: "auth fallback", statuses: [401, 404], source: fallbackAuth },
  { rejection: "MIME type", statuses: [200], source: auth },
])("closes streaming responses rejected by $rejection", async ({ statuses, source }) => {
  const { closed, requestCount } = await streamResponses(statuses);
  await expect(fetchPluginIconBlobUrl(iconParams({ auth: source }))).resolves.toBeNull();
  expect(requestCount()).toBe(statuses.length);
  await vi.waitFor(() => expect(closed).toEqual(new Set(statuses.map((_, i) => i))), {
    timeout: 1_000,
  });
});

it("does not wait for a stalled response cancellation before auth fallback", async () => {
  const cancellation = createDeferred();
  const cancel = vi.fn(() => cancellation.promise);
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(rejectedResponse(401, cancel))
    .mockResolvedValueOnce(rejectedResponse(404, cancel));
  vi.stubGlobal("fetch", fetchMock);

  await expect(fetchPluginIconBlobUrl(iconParams({ auth: fallbackAuth }))).resolves.toBeNull();

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalledTimes(2);
  cancellation.resolve();
});
