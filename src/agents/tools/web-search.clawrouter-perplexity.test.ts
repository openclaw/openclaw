import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { createWebSearchTool } from "./web-search.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let listener: Awaited<ReturnType<typeof reserveTestPortListener>>;
let config: OpenClawConfig;
let baseUrl: string;
let kind: string;
let eligible: boolean;
let current: boolean;
let retireAfterCatalog: boolean;
let responseFormat: string;
let routeOverride: string | undefined;
let mode: "json" | "partial";
let payload: unknown;
let started: ReturnType<typeof Promise.withResolvers<ServerResponse>>;
const calls: Array<{ path: string; method?: string; auth?: string; body: unknown }> = [];
const row = {
  title: "Synthetic source",
  url: "https://example.com/source",
  snippet: "Untrusted fixture text",
  date: "2026-11-20",
};
const route = () =>
  kind === "native" ? "/v1/native/perplexity/search" : "/v1/proxy/perplexity/search";

const server = createServer((request, response) => {
  void (async () => {
    const bytes = await buffer(request);
    calls.push({
      path: request.url ?? "",
      method: request.method,
      auth: request.headers.authorization,
      body: bytes.length ? JSON.parse(bytes.toString()) : undefined,
    });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/catalog") {
      response.end(
        JSON.stringify({
          version: "clawrouter.client-catalog.v1",
          providers: [
            {
              id: "perplexity",
              allowed: true,
              executable: true,
              nativeBaseUrl: "/v1/native/perplexity",
              models: [],
              routes: [
                {
                  endpoint: "search",
                  path: "/search",
                  methods: ["POST"],
                  requestFormat: "perplexity.search",
                  responseFormat,
                },
              ],
              offers: [
                {
                  endpoint: "search",
                  modelId: null,
                  eligible,
                  affordability: "request-dependent",
                  transport: "http",
                  routeKind: kind,
                  route: routeOverride ?? route(),
                },
              ],
            },
          ],
        }),
      );
      if (retireAfterCatalog) {
        current = false;
      }
    } else if (mode === "partial") {
      response.write('{"results":[');
      started.resolve(response);
    } else {
      response.end(JSON.stringify(payload));
    }
  })().catch(() => {
    response.statusCode = 500;
    response.end();
  });
});

beforeAll(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-router-perplexity-",
    applyEnv: true,
    prepareProfileCatalog: false,
    env: {
      OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../../extensions", import.meta.url)),
      CLAWROUTER_API_KEY: undefined,
      PERPLEXITY_API_KEY: undefined,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      ALL_PROXY: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
      all_proxy: undefined,
    },
  });
  listener = await reserveTestPortListener({ offsets: [0], createListener: () => server });
  baseUrl = `http://127.0.0.1:${listener.claim.port}/v1`;
});

afterAll(async () => {
  try {
    const closed = listener.releaseListener();
    server.closeAllConnections();
    await closed;
  } finally {
    try {
      await listener.claim.release();
    } finally {
      await state.cleanup();
    }
  }
});

beforeEach(() => {
  calls.length = 0;
  kind = "native";
  eligible = current = true;
  retireAfterCatalog = false;
  responseFormat = "perplexity.search";
  routeOverride = undefined;
  mode = "json";
  payload = { results: [row] };
  started = Promise.withResolvers<ServerResponse>();
  config = {
    tools: { web: { search: { provider: "clawrouter", cacheTtlMinutes: 0 } } },
    plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
    models: {
      providers: {
        clawrouter: { baseUrl, apiKey: "synthetic-router-key", models: [] },
        perplexity: {
          baseUrl: "https://upstream.example",
          apiKey: "unused-upstream-key",
          models: [],
        },
      },
    },
  };
});

function execute(args: Record<string, unknown> = {}, signal?: AbortSignal) {
  const tool = createWebSearchTool({
    config,
    agentDir: state.agentDir(),
    assertInvocationCurrent: () => {
      if (!current) {
        throw new Error("Retired search invocation");
      }
    },
  });
  if (!tool) {
    throw new Error("Expected registered web_search");
  }
  return tool.execute("router-perplexity", { query: "synthetic query", ...args }, signal);
}

it.each(["native", "manifest"])(
  "executes the %s Perplexity codec through registered web_search",
  async (routeKind) => {
    kind = routeKind;
    const result = await execute({ count: 2 });
    expect(result.details).toMatchObject({
      kind: "results",
      provider: "clawrouter",
      count: 1,
      results: [
        {
          url: row.url,
          title: expect.stringContaining(row.title),
          snippet: expect.stringMatching(/EXTERNAL_UNTRUSTED_CONTENT[\s\S]*Untrusted fixture text/),
          published: row.date,
        },
      ],
      externalContent: { untrusted: true, wrapped: true, provider: "clawrouter" },
    });
    const body = { query: "synthetic query", max_results: 2 };
    expect(calls).toEqual([
      { path: "/v1/catalog", method: "GET", auth: "Bearer synthetic-router-key", body: undefined },
      {
        path: route(),
        method: "POST",
        auth: "Bearer synthetic-router-key",
        body: kind === "manifest" ? { body } : body,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("synthetic-router-key");
  },
);

it("defaults to five, accepts the UTF-8 byte boundary, and retains result order without refill", async () => {
  await execute();
  expect(calls.at(-1)?.body).toEqual({ query: "synthetic query", max_results: 5 });
  const query = "界".repeat(2730) + "ab";
  payload = { results: [row, { ...row, url: "https://example.com/second" }] };
  const result = await execute({ query, count: 10 });
  expect(calls.at(-1)?.body).toEqual({ query, max_results: 10 });
  expect(result.details).toMatchObject({
    results: [{ url: row.url }, { url: "https://example.com/second" }],
  });
  payload = { results: [null, { url: "javascript:alert(1)" }, row] };
  expect((await execute({ count: 2 })).details).toMatchObject({
    kind: "results",
    count: 0,
    results: [],
  });
  payload = { results: [] };
  expect((await execute()).details).toMatchObject({ kind: "results", count: 0, results: [] });
});

it.each([
  { query: "界".repeat(2731) },
  { query: ["not a string"] },
  { query: " " },
  { count: 0 },
  { count: 11 },
])("rejects unsupported request input before search dispatch %#", async (args) => {
  const outcome = await execute(args).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  if ("error" in outcome) {
    expect(outcome.error).toBeInstanceOf(Error);
  } else {
    expect(outcome.result.details).toMatchObject({ kind: "error" });
  }
  expect(calls.every((call) => call.path === "/v1/catalog")).toBe(true);
});

it.each(["native", "manifest"])(
  "refreshes %s grants and the selected Router credential",
  async (routeKind) => {
    kind = routeKind;
    await execute();
    config.models!.providers!.clawrouter!.apiKey = "rotated-router-key";
    await execute();
    expect(calls.slice(-2).map((call) => call.auth)).toEqual([
      "Bearer rotated-router-key",
      "Bearer rotated-router-key",
    ]);
    eligible = false;
    expect((await execute()).details).toMatchObject({ kind: "error", provider: "clawrouter" });
    expect(calls.map((call) => call.path)).toEqual([
      "/v1/catalog",
      route(),
      "/v1/catalog",
      route(),
      "/v1/catalog",
    ]);
  },
);

it.each(["format", "foreign route", "retired"])(
  "rejects a %s catalog before dispatch",
  async (fault) => {
    if (fault === "format") {
      responseFormat = "perplexity.agent";
    }
    if (fault === "foreign route") {
      routeOverride = "https://upstream.example/search";
    }
    if (fault === "retired") {
      retireAfterCatalog = true;
    }
    if (fault === "retired") {
      await expect(execute()).rejects.toThrow("Retired search invocation");
    } else {
      expect((await execute()).details).toMatchObject({ kind: "error" });
    }
    expect(calls.map((call) => call.path)).toEqual(["/v1/catalog"]);
  },
);

it.each([{ results: {} }, { results: [{ ...row, snippet: "x".repeat(1024 * 1024) }] }])(
  "rejects malformed or oversized responses without another search",
  async (body) => {
    payload = body;
    expect((await execute()).details).toMatchObject({ kind: "error" });
    expect(calls.map((call) => call.path)).toEqual(["/v1/catalog", route()]);
  },
);

it("preserves cancellation before admission and through an active response, with no alternate request", async () => {
  const before = new AbortController();
  const reason = new Error("Synthetic caller cancellation");
  before.abort(reason);
  await expect(execute({}, before.signal)).rejects.toBe(reason);
  expect(calls).toHaveLength(0);
  kind = "manifest";
  mode = "partial";
  const controller = new AbortController();
  const pending = execute({}, controller.signal);
  const response = await started.promise;
  const closed = once(response, "close");
  const rejected = expect(pending).rejects.toBe(reason);
  controller.abort(reason);
  await rejected;
  await closed;
  expect(response.writableFinished).toBe(false);
  expect(calls.map((call) => call.path)).toEqual(["/v1/catalog", route()]);
});

it("bounds an unfinished response by the existing deadline and releases the connection", async () => {
  mode = "partial";
  const pending = execute();
  const response = await started.promise;
  const closed = once(response, "close");
  expect((await pending).details).toMatchObject({ kind: "error", provider: "clawrouter" });
  await closed;
  expect(response.writableFinished).toBe(false);
  expect(calls.map((call) => call.path)).toEqual(["/v1/catalog", route()]);
}, 45_000);
