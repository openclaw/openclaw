import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  withStrictGuardedFetchMode: <T>(params: T) => params,
  withTrustedExplicitProxyGuardedFetchMode: <T>(params: T) => ({
    ...params,
    mode: "trusted_explicit_proxy",
  }),
}));

type FetchModule = typeof import("./fetch.js");
type ReadRemoteMediaBuffer = FetchModule["readRemoteMediaBuffer"];
type SaveRemoteMedia = FetchModule["saveRemoteMedia"];
type SaveResponseMedia = FetchModule["saveResponseMedia"];
type LookupFn = NonNullable<Parameters<ReadRemoteMediaBuffer>[0]["lookupFn"]>;
let readRemoteMediaBuffer: ReadRemoteMediaBuffer;
let saveRemoteMedia: SaveRemoteMedia;
let saveResponseMedia: SaveResponseMedia;
let tempHome: TempHomeEnv;

function makeStream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function makeStreamResponse(bytes: number[], headers: HeadersInit) {
  return new Response(makeStream([new Uint8Array(bytes)]), { status: 200, headers });
}

function makeResponseFetch(chunks: Uint8Array[], headers?: HeadersInit) {
  return vi.fn(async () => new Response(makeStream(chunks), { status: 200, headers }));
}

function makeCancelableStream(chunks: Uint8Array[]) {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
    },
    cancel() {
      canceled = true;
    },
  });
  return { stream, wasCanceled: () => canceled };
}

function makeLookupFn(): LookupFn {
  return vi.fn(async () => ({ address: "149.154.167.220", family: 4 })) as unknown as LookupFn;
}

export {
  fetchWithSsrFGuardMock,
  readRemoteMediaBuffer,
  saveRemoteMedia,
  saveResponseMedia,
  tempHome,
  makeStreamResponse,
  makeResponseFetch,
  makeCancelableStream,
  makeLookupFn,
};

export function installMediaFetchTestHooks(): void {
  beforeAll(async () => {
    vi.resetModules();
    tempHome = await createTempHomeEnv("openclaw-test-home-");
    const fetchModule = await import("./fetch.js");
    readRemoteMediaBuffer = fetchModule.readRemoteMediaBuffer;
    saveRemoteMedia = fetchModule.saveRemoteMedia;
    saveResponseMedia = fetchModule.saveResponseMedia;
  });

  beforeEach(() => {
    vi.useRealTimers();
    fetchWithSsrFGuardMock.mockReset().mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        url: string;
        fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
        beforeRequest?: () => void;
        init?: RequestInit;
        signal?: AbortSignal;
      };
      if (params.url.startsWith("http://127.0.0.1/")) {
        throw new Error("Blocked hostname or private/internal/special-use IP address");
      }
      const fetcher = params.fetchImpl ?? globalThis.fetch;
      if (!fetcher) {
        throw new Error("fetch is not available");
      }
      params.beforeRequest?.();
      return {
        response: await fetcher(params.url, {
          ...params.init,
          ...(params.signal ? { signal: params.signal } : {}),
        }),
        finalUrl: params.url,
        release: async () => {},
      };
    });
  });

  afterAll(async () => {
    try {
      await tempHome.restore();
    } finally {
      vi.doUnmock("../infra/net/fetch-guard.js");
      vi.resetModules();
    }
  });
}
