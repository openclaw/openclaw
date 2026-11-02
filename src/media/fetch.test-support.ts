import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import type { GuardedFetchOptions } from "../infra/net/fetch-guard.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
export { fetchWithSsrFGuardMock };

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  withStrictGuardedFetchMode: <T>(params: T) => params,
  withTrustedExplicitProxyGuardedFetchMode: <T>(params: T) => ({
    ...params,
    mode: "trusted_explicit_proxy",
  }),
}));

type FetchModule = typeof import("./fetch.js");
type LookupFn = NonNullable<Parameters<FetchModule["readRemoteMediaBuffer"]>[0]["lookupFn"]>;
export let readRemoteMediaBuffer: FetchModule["readRemoteMediaBuffer"];
export let saveRemoteMedia: FetchModule["saveRemoteMedia"];
export let saveResponseMedia: FetchModule["saveResponseMedia"];
export let tempHome: TempHomeEnv;

function makeStream(chunks: Uint8Array[], cancel?: () => void) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      if (!cancel) {
        controller.close();
      }
    },
    cancel,
  });
}

export function makeStreamResponse(bytes: number[], headers: HeadersInit) {
  return new Response(makeStream([new Uint8Array(bytes)]), { status: 200, headers });
}

export function makeResponseFetch(chunks: Uint8Array[], headers?: HeadersInit) {
  return vi.fn(async () => new Response(makeStream(chunks), { status: 200, headers }));
}

export function makeCancelableStream(chunks: Uint8Array[]) {
  let canceled = false;
  const stream = makeStream(chunks, () => {
    canceled = true;
  });
  return { stream, wasCanceled: () => canceled };
}

export function makeLookupFn(): LookupFn {
  return vi.fn(async () => ({ address: "149.154.167.220", family: 4 })) as unknown as LookupFn;
}

export function installMediaFetchTestHooks(): void {
  beforeAll(async () => {
    vi.resetModules();
    tempHome = await createTempHomeEnv("openclaw-test-home-");
    ({ readRemoteMediaBuffer, saveRemoteMedia, saveResponseMedia } = await import("./fetch.js"));
  });

  beforeEach(() => {
    vi.useRealTimers();
    fetchWithSsrFGuardMock.mockReset().mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as GuardedFetchOptions;
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
