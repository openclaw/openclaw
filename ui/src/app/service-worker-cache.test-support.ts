import { createHash, webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { vi } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceWorkerPath = path.join(here, "../../public/sw.js");

export type ServiceWorkerFetchRequest = Pick<
  Request,
  "url" | "method" | "mode" | "cache" | "headers"
>;
type CacheRequest = string | ServiceWorkerFetchRequest;
export const offlineBootFixture = {
  id: "fixture",
  routes: ["/chat", "/new", "/settings", "/settings/connection"],
  routePrefixes: ["/chat/", "/dashboard/", "/settings/agents/"],
  html: '<!doctype html><html><head><script src="./assets/app-AbCd1234.js"></script></head><body>generic shell</body></html>',
  csp: "default-src 'self'; base-uri 'none'",
  assets: [
    {
      path: "assets/app-AbCd1234.js",
      integrity: "sha256-" + createHash("sha256").update("build asset").digest("base64"),
    },
    {
      path: "assets/chat-AbCd1234.css",
      integrity: "sha256-" + createHash("sha256").update("build asset").digest("base64"),
    },
  ] as const,
  deferredAssets: [
    "session-actions",
    "session-organizer-operations.runtime",
    "rename",
    "reactions",
    "drafts",
  ].map((name) => ({
    path: `assets/${name}-AbCd1234.js`,
    integrity: "sha256-" + createHash("sha256").update("build asset").digest("base64"),
  })),
  publicAssetVersion: "public-fixture",
  publicAssets: ["fonts/custom.woff2", "themes/custom.css", "manifest.webmanifest"],
};
type ServiceWorkerFetchEventStub = {
  request: ServiceWorkerFetchRequest;
  clientId: string;
  respondWith(promise: Promise<Response | undefined>): void;
  waitUntil(promise: Promise<unknown>): void;
  data?: {
    type: string;
    active?: boolean;
    offlinePrecache?: { saveData?: boolean; effectiveType?: string };
  };
  source?: { id: string; type: string; url: string };
  ports?: Array<{ postMessage(message: unknown): void }>;
};

export function stallDownloads(worker: ReturnType<typeof createFetchServiceWorker>) {
  const signals: AbortSignal[] = [];
  worker.fetch.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        const signal = options!.signal!;
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
  return signals;
}

export function createFetchServiceWorker(
  scope = "https://control.example/openclaw/",
  options: {
    clientUrl?: string;
    clientType?: string;
    online?: boolean;
    assets?: Array<{ path: string; integrity: string }>;
  } = {},
) {
  const listeners = new Map<string, (event: ServiceWorkerFetchEventStub) => void>();
  const cache = new Map<string, Response>();
  const priorCache = new Map<string, Response>();
  const olderCache = new Map<string, Response>();
  const generations = new Map([
    ["openclaw-control-older", olderCache],
    ["openclaw-control-old", priorCache],
    ["openclaw-control-dev-fixture", cache],
  ]);
  const cacheDelete = vi.fn(async (name: string) => generations.delete(name));
  const cacheMatch = vi.fn(async (request: CacheRequest, matchOptions?: { cacheName: string }) =>
    generations
      .get(matchOptions?.cacheName ?? "openclaw-control-dev-fixture")
      ?.get(typeof request === "string" ? request : request.url)
      ?.clone(),
  );
  const cachePut = vi.fn(async (request: CacheRequest, response: Response) => {
    cache.set(typeof request === "string" ? request : request.url, response);
  });
  const fetch = vi.fn<(request: CacheRequest, options?: RequestInit) => Promise<Response>>();
  const skipWaiting = vi.fn(async () => undefined);
  const navigator = { onLine: options.online ?? true };
  const probeReply = vi.fn();
  const info = vi.fn();
  const pendingWrites: Promise<unknown>[] = [];
  const waitUntil = vi.fn((pending: Promise<unknown>) => {
    pendingWrites.push(pending);
  });
  const windowClients = [
    {
      id: "requesting-window",
      type: options.clientType ?? "window",
      url: options.clientUrl ?? `${scope}chat`,
      postMessage: vi.fn(),
    },
    { id: "another-window", type: "window", url: `${scope}chat/other`, postMessage: vi.fn() },
  ] as const;
  const getClient = vi.fn(async (id: string) => windowClients.find((client) => client.id === id));
  const matchClients = vi.fn(async (): Promise<Array<(typeof windowClients)[number]>> => [
    ...windowClients,
  ]);
  const source = fs
    .readFileSync(serviceWorkerPath, "utf8")
    .replace(
      "const OFFLINE_BOOT = null;",
      () =>
        `const OFFLINE_BOOT = ${JSON.stringify({ ...offlineBootFixture, assets: options.assets ?? offlineBootFixture.assets })};`,
    );
  new vm.Script(source, {
    filename: "ui/public/sw.js",
  }).runInNewContext({
    URL,
    Response,
    crypto: webcrypto,
    btoa,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { info },
    Date,
    caches: {
      match: cacheMatch,
      open: async () => ({ put: cachePut }),
      keys: async () => [...generations.keys()],
      delete: cacheDelete,
    },
    fetch,
    self: {
      addEventListener: (type: string, listener: (event: ServiceWorkerFetchEventStub) => void) =>
        listeners.set(type, listener),
      location: new URL("sw.js", scope),
      registration: { scope },
      navigator,
      skipWaiting,
      clients: {
        get: getClient,
        claim: async () => undefined,
        matchAll: matchClients,
      },
    },
  });
  const createLifecycleRequest = (): ServiceWorkerFetchRequest => ({
    url: scope,
    method: "GET",
    mode: "cors",
    cache: "default",
    headers: new Headers(),
  });
  return {
    scope,
    cache,
    priorCache,
    olderCache,
    generations,
    info,
    cacheDelete,
    cacheMatch,
    cachePut,
    fetch,
    windowClients,
    getClient,
    matchClients,
    skipWaiting,
    waitUntil,
    probeReply,
    foregroundActivity(active: boolean, windowIndex = 0) {
      listeners.get("message")?.({
        data: { type: "openclaw-foreground-activity", active },
        source: windowClients[windowIndex],
        request: createLifecycleRequest(),
        clientId: "",
        respondWith: vi.fn(),
        waitUntil,
      });
    },
    setOnline(online: boolean) {
      navigator.onLine = online;
    },
    async activate() {
      listeners.get("activate")?.({
        waitUntil,
        request: createLifecycleRequest(),
        clientId: "",
        respondWith: vi.fn(),
      });
      await Promise.all(pendingWrites);
    },
    probe(offlinePrecache?: { saveData?: boolean; effectiveType?: string }) {
      const start = pendingWrites.length;
      listeners.get("message")?.({
        data: { type: "sw-version-probe", offlinePrecache },
        ports: [{ postMessage: probeReply }],
        request: createLifecycleRequest(),
        clientId: "requesting-window",
        respondWith: vi.fn(),
        waitUntil,
      });
      return Promise.all(pendingWrites.slice(start));
    },
    async install() {
      listeners.get("install")?.({
        waitUntil,
        request: createLifecycleRequest(),
        clientId: "",
        respondWith: vi.fn(),
      });
      await Promise.all(pendingWrites);
    },
    async dispatch(
      requestOptions: Partial<ServiceWorkerFetchRequest> & { clientId?: string } = {},
    ) {
      const start = pendingWrites.length;
      let completion: Promise<Response | undefined> | undefined;
      listeners.get("fetch")?.({
        request: {
          url:
            requestOptions.url ??
            `${scope}__openclaw__/assistant-media?source=media://inbound/image`,
          method: requestOptions.method ?? "GET",
          mode: requestOptions.mode ?? "cors",
          cache: requestOptions.cache ?? "default",
          headers: requestOptions.headers ?? new Headers(),
        },
        clientId: requestOptions.clientId ?? "requesting-window",
        respondWith(pending) {
          completion = pending;
        },
        waitUntil,
      });
      const result = await completion;
      await Promise.all(pendingWrites.slice(start));
      return result;
    },
  };
}
