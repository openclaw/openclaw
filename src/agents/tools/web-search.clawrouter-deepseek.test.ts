import { once } from "node:events";
import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { WebSearchOutputSchema } from "./web-search-output.js";
import { createWebSearchTool } from "./web-search.js";

const proxyKey = "synthetic-proxy-search-key";
const vendorKey = "synthetic-unused-deepseek-key";
const source = {
  title: "Native result",
  url: "https://example.com/source",
  summary: "Native summary",
  snippet: "Lower-priority snippet",
  date: "2026-10-17",
  site_name: "Example",
};
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let releasePort: () => Promise<void>;
let baseUrl: string;
let routeKind: "native" | "manifest";
let catalog: ReturnType<typeof makeCatalog>;
let responseStatus: number;
let responseHeaders: Record<string, string>;
let responseBody: string;
let hang: boolean;
let started: ReturnType<typeof Promise.withResolvers<void>>;
let closed: ReturnType<typeof Promise.withResolvers<void>>;
const requests: Array<{ path: string; auth?: string; vendor?: string; body: unknown }> = [];

function makeCatalog() {
  return {
    version: "clawrouter.client-catalog.v1",
    observedAt: new Date().toISOString(),
    scope: { authType: "proxy_key", credentialId: "synthetic-grant" },
    providers: [
      {
        id: "deepseek",
        allowed: true,
        executable: true,
        nativeBaseUrl: "/v1/native/deepseek",
        models: [] as Array<Record<string, unknown>>,
        routes: [
          {
            endpoint: "search",
            path: "/v1/tools/search",
            methods: ["POST"],
            requestFormat: "deepseek.search",
            responseFormat: "deepseek.search",
          },
        ],
        offers: [
          {
            endpoint: "search",
            modelId: null as string | null,
            eligible: true,
            affordability: "request-dependent",
            transport: "http",
            routeKind,
            route:
              routeKind === "native"
                ? "/v1/native/deepseek/v1/tools/search"
                : "/v1/proxy/deepseek/search",
          },
        ],
      },
    ],
  };
}

const server = createServer((request, response) => {
  void (async () => {
    const bytes = await buffer(request);
    requests.push({
      path: request.url ?? "",
      auth: request.headers.authorization,
      vendor: (request.headers["x-api-key"] ?? request.headers["x-deepseek-api-key"]) as
        | string
        | undefined,
      body: bytes.length ? JSON.parse(bytes.toString()) : undefined,
    });
    if (request.url === "/tenant/v1/catalog") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(catalog));
      return;
    }
    response.on("close", () => closed.resolve());
    response.writeHead(responseStatus, responseHeaders);
    if (hang) {
      response.write('{"results":[');
      started.resolve();
      return;
    }
    response.end(responseBody);
  })().catch(() => {
    response.statusCode = 500;
    response.end();
  });
});

beforeAll(async () => {
  state = await createOpenClawTestState({
    prefix: "clawrouter-deepseek-search-",
    applyEnv: true,
    prepareProfileCatalog: false,
    env: {
      OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../../extensions", import.meta.url)),
      CLAWROUTER_API_KEY: undefined,
      DEEPSEEK_API_KEY: vendorKey,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      ALL_PROXY: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
      all_proxy: undefined,
    },
  });
  const claim = await acquireTestPortBlock({ offsets: [0] });
  releasePort = claim.release;
  server.listen(claim.port, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${claim.port}/tenant/v1`;
});

beforeEach(() => {
  routeKind = "native";
  catalog = makeCatalog();
  requests.length = 0;
  responseStatus = 200;
  responseHeaders = { "Content-Type": "application/json" };
  responseBody = JSON.stringify({ results: [source] });
  hang = false;
  started = Promise.withResolvers<void>();
  closed = Promise.withResolvers<void>();
  const nativeFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== new URL(baseUrl).origin) {
      throw new Error("Unexpected non-fixture HTTP egress");
    }
    return nativeFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  const closing = server[Symbol.asyncDispose]();
  server.closeAllConnections();
  await closing;
  await releasePort();
  await state.cleanup();
});

function config(key: string | undefined = proxyKey): OpenClawConfig {
  return {
    tools: { web: { search: { provider: "clawrouter", cacheTtlMinutes: 0 } } },
    plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
    models: {
      providers: {
        clawrouter: {
          baseUrl,
          apiKey: key,
          auth: "api-key",
          models: [],
          headers: { "X-API-Key": vendorKey, "X-DeepSeek-API-Key": vendorKey },
        },
        deepseek: { baseUrl: "https://api.deepseek.com", apiKey: vendorKey, models: [] },
      },
    },
  };
}

async function execute(args: Record<string, unknown> = {}, cfg = config(), signal?: AbortSignal) {
  const tool = createWebSearchTool({ config: cfg, agentDir: state.agentDir() });
  if (!tool) {
    throw new Error("Expected configured ClawRouter web_search tool");
  }
  const result = await tool.execute("proxy-search", { query: "synthetic query", ...args }, signal);
  expect(Value.Check(WebSearchOutputSchema, result.details)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(proxyKey);
  expect(JSON.stringify(result)).not.toContain(vendorKey);
  return result.details as Record<string, unknown>;
}

it.each(["native", "manifest"] as const)(
  "executes actual web_search through the %s offer",
  async (kind) => {
    routeKind = kind;
    catalog = makeCatalog();
    const result = await execute({ count: 2 });
    expect(result).toMatchObject({
      kind: "results",
      provider: "clawrouter",
      count: 1,
      results: [
        {
          title: expect.stringContaining("Native result"),
          url: source.url,
          snippet: expect.stringContaining("Native summary"),
          published: source.date,
          siteName: expect.stringContaining("Example"),
        },
      ],
      externalContent: { untrusted: true, wrapped: true, provider: "clawrouter" },
    });
    expect(JSON.stringify(result)).not.toContain("Lower-priority snippet");
    expect(requests).toEqual([
      {
        path: "/tenant/v1/catalog",
        auth: `Bearer ${proxyKey}`,
        vendor: undefined,
        body: undefined,
      },
      {
        path:
          kind === "native"
            ? "/tenant/v1/native/deepseek/v1/tools/search"
            : "/tenant/v1/proxy/deepseek/search",
        auth: `Bearer ${proxyKey}`,
        vendor: undefined,
        body:
          kind === "native"
            ? { query: "synthetic query", count: 2, need_content: false }
            : { body: { query: "synthetic query", count: 2, need_content: false } },
      },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  },
);

it("sends the explicit default count, permits 128 code points and preserves an empty result", async () => {
  responseBody = '{"results":[]}';
  expect(await execute({ query: "🦊".repeat(128) })).toMatchObject({
    kind: "results",
    count: 0,
    results: [],
  });
  expect(requests[1]?.body).toEqual({ query: "🦊".repeat(128), count: 5, need_content: false });
});

it("refreshes the catalog and credential on each caller invocation", async () => {
  await execute();
  await execute({}, config("synthetic-other-proxy-key"));
  expect(requests.map((r) => r.auth)).toEqual([
    `Bearer ${proxyKey}`,
    `Bearer ${proxyKey}`,
    "Bearer synthetic-other-proxy-key",
    "Bearer synthetic-other-proxy-key",
  ]);
  expect(requests.filter((r) => r.path.endsWith("/catalog"))).toHaveLength(2);
});

it.each([
  "stale",
  "foreign-scope",
  "foreign-provider",
  "model",
  "wrong-path",
  "wrong-format",
  "ineligible",
])("denies the %s catalog before search dispatch", async (reason) => {
  const provider = catalog.providers[0]!;
  if (reason === "stale") {
    catalog.observedAt = new Date(Date.now() - 120_000).toISOString();
  }
  if (reason === "foreign-scope") {
    catalog.scope.authType = "upstream_key";
  }
  if (reason === "foreign-provider") {
    provider.id = "foreign";
    provider.nativeBaseUrl = "/v1/native/foreign";
    provider.offers[0]!.route = "/v1/native/foreign/v1/tools/search";
  }
  if (reason === "model") {
    provider.models = [{ id: "deepseek/chat", capabilities: ["web.search"] }];
    provider.offers[0]!.modelId = "deepseek/chat";
  }
  if (reason === "wrong-path") {
    provider.routes[0]!.path = "/chat/completions";
    provider.offers[0]!.route = "/v1/native/deepseek/chat/completions";
  }
  if (reason === "wrong-format") {
    provider.routes[0]!.responseFormat = "openai.chat_completions";
  }
  if (reason === "ineligible") {
    provider.offers[0]!.eligible = false;
  }
  expect(await execute()).toMatchObject({ kind: "error", provider: "clawrouter" });
  expect(requests.map((r) => r.path)).toEqual(["/tenant/v1/catalog"]);
});

it.each([
  { query: "x".repeat(129) },
  { query: "\ud800" },
  { query: "\udc00" },
  { need_content: true },
  { country: "US" },
])("rejects unsupported DeepSeek input %j before POST", async (args) => {
  expect(await execute(args)).toMatchObject({ kind: "error", provider: "clawrouter" });
  expect(requests.map((r) => r.path)).toEqual(["/tenant/v1/catalog"]);
});

it.each([0, 11, 1.5])("rejects count %s before network dispatch", async (count) => {
  expect(await execute({ count })).toMatchObject({
    kind: "error",
    provider: "clawrouter",
    error: "provider_error",
    message: expect.stringContaining("Search failed (HTTP 400)"),
  });
  expect(requests).toHaveLength(0);
});

it.each([
  "partial",
  "redirect",
  "mime",
  "compressed",
  "excess",
  "unsafe-url",
  "credentials",
  "oversized",
  "truncated",
])("rejects a %s native response without replay or result URL fetch", async (kind) => {
  if (kind === "partial") {
    responseStatus = 206;
    responseHeaders["Content-Range"] = "bytes 0-10/100";
  }
  if (kind === "redirect") {
    responseStatus = 302;
    responseHeaders.Location = "/follow";
  }
  if (kind === "mime") {
    responseHeaders["Content-Type"] = "text/plain";
  }
  if (kind === "compressed") {
    responseHeaders["Content-Encoding"] = "unsupported-encoding";
  }
  if (kind === "excess") {
    responseBody = JSON.stringify({ results: [source, source] });
  }
  if (kind === "unsafe-url") {
    responseBody = JSON.stringify({ results: [{ ...source, url: "javascript:alert(1)" }] });
  }
  if (kind === "credentials") {
    responseBody = JSON.stringify({
      results: [{ ...source, url: "https://user:pass@example.com/" }],
    });
  }
  if (kind === "oversized") {
    responseBody = JSON.stringify({ results: [{ ...source, summary: "x".repeat(1024 * 1024) }] });
  }
  if (kind === "truncated") {
    responseBody = '{"results":[';
  }
  expect(await execute({ count: 1 })).toMatchObject({ kind: "error", provider: "clawrouter" });
  expect(requests).toHaveLength(2);
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});

it("rejects a manifest redirect before following it or replaying the search", async () => {
  routeKind = "manifest";
  catalog = makeCatalog();
  responseStatus = 307;
  responseHeaders.Location = "/follow";
  expect(await execute()).toMatchObject({ kind: "error", provider: "clawrouter" });
  expect(requests.map((request) => request.path)).toEqual([
    "/tenant/v1/catalog",
    "/tenant/v1/proxy/deepseek/search",
  ]);
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});

it("does not borrow the configured or environment DeepSeek key when the proxy key is absent", async () => {
  const cfg = config();
  delete cfg.models!.providers!.clawrouter!.apiKey;
  expect(await execute({}, cfg)).toMatchObject({ kind: "error", provider: "clawrouter" });
  expect(requests).toHaveLength(0);
});

it("cancels an incomplete native result and closes the response without replay", async () => {
  hang = true;
  const controller = new AbortController();
  const pending = execute({}, config(), controller.signal);
  await started.promise;
  controller.abort(new Error("search caller cancelled"));
  await expect(pending).rejects.toThrow(/cancelled/);
  await closed.promise;
  expect(requests).toHaveLength(2);
});
