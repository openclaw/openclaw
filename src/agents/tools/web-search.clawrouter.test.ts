import { createServer, type Server } from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCapturedPluginRegistration } from "../../plugins/captured-registration.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { createWebSearchTool } from "./web-search.js";

const rootDir = path.resolve(import.meta.dirname, "../../../extensions/clawrouter");
const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "clawrouter",
      rootDir,
      providers: ["clawrouter"],
      contracts: { webSearchProviders: ["clawrouter"] },
    },
  ],
});
const pluginRegistry = createEmptyPluginRegistry();
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let server: Awaited<ReturnType<typeof reserveTestPortListener<Server>>>;
let baseUrl: string;
let routeKind: "native" | "manifest" = "native";
let replyStatus = 200;
let reply: Record<string, unknown>;
let catalog: ReturnType<typeof catalogFixture>;
const requests: Array<{
  path?: string;
  authorization?: string;
  upstreamKey?: string;
  body: unknown;
}> = [];

function catalogFixture() {
  return {
    version: "clawrouter.client-catalog.v1",
    providers: [
      {
        id: "xai",
        allowed: true,
        executable: true,
        nativeBaseUrl: "/v1/native/xai",
        routes: [
          {
            endpoint: "responses",
            path: "/v1/responses",
            methods: ["POST"],
            requestFormat: "openai.responses",
            responseFormat: "openai.responses",
          },
        ],
        models: [
          {
            id: "xai/grok-4.7",
            upstream: "grok-4.7",
            capabilities: ["llm.responses"],
            supportedReasoningEfforts: ["low", "medium", "high"],
            nativeCapabilities: {
              version: "clawrouter.native-capabilities.v1",
              endpoints: { responses: { hostedTools: ["web_search"] } },
            },
          },
        ],
        offers: [
          {
            endpoint: "responses",
            modelId: "xai/grok-4.7",
            eligible: true,
            transport: "http",
            affordability: "request-dependent",
            routeKind,
            route:
              routeKind === "native" ? "/v1/native/xai/v1/responses" : "/v1/proxy/xai/responses",
            hostedToolAdmission: {
              version: "clawrouter.hosted-tool-admission.v1",
              web_search: "admitted",
            },
          },
        ],
      },
    ],
  };
}

function config(apiKey = "synthetic-router-key"): OpenClawConfig {
  return {
    plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
    models: { providers: { clawrouter: { baseUrl, apiKey, models: [] } } },
    tools: { web: { search: { provider: "clawrouter" } } },
  };
}

function execute(apiKey?: string, signal?: AbortSignal) {
  return withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, async () => {
    const tool = createWebSearchTool({ config: config(apiKey), agentDir: state.agentDir() });
    if (!tool) {
      throw new Error("web_search unavailable");
    }
    return tool.execute("native-search", { query: "synthetic query", count: 2 }, signal);
  });
}

beforeAll(async () => {
  state = await createOpenClawTestState({
    label: "clawrouter-native-search",
    applyEnv: true,
    env: { XAI_API_KEY: "synthetic-unrelated-xai", CLAWROUTER_API_KEY: undefined },
  });
  const captured = createCapturedPluginRegistration();
  const entry = await loadBundledPluginFacade<{
    default: { register: (api: typeof captured.api) => void };
  }>({
    pluginId: "clawrouter",
    artifactBasename: "index.ts",
  });
  entry.default.register(captured.api);
  pluginRegistry.webSearchProviders = captured.webSearchProviders.map((provider) => ({
    pluginId: "clawrouter",
    source: "fixture",
    rootDir,
    provider,
  }));
  server = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          const bytes = await buffer(request);
          requests.push({
            path: request.url,
            authorization: request.headers.authorization,
            upstreamKey: request.headers["x-api-key"] as string | undefined,
            body: bytes.length ? JSON.parse(bytes.toString()) : undefined,
          });
          response.setHeader("Content-Type", "application/json");
          if (request.url === "/v1/catalog") {
            response.end(JSON.stringify(catalog));
            return;
          }
          response.statusCode = replyStatus;
          if (replyStatus === 307) {
            response.setHeader("Location", "/replayed-search");
          }
          response.end(JSON.stringify(reply));
        })().catch(() => {
          response.statusCode = 500;
          response.end();
        });
      }),
  });
  baseUrl = `http://127.0.0.1:${server.claim.port}/v1`;
});

afterAll(async () => {
  await server?.releaseListener();
  await server?.claim.release();
  await state?.cleanup();
});

beforeEach(() => {
  routeKind = "native";
  replyStatus = 200;
  requests.length = 0;
  catalog = catalogFixture();
  reply = {
    id: "resp_synthetic_search",
    model: "grok-4.7",
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [
      { type: "web_search_call", status: "completed" },
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Example " },
          {
            type: "output_text",
            text: "answer.",
            annotations: [
              {
                type: "url_citation",
                url: "https://example.com/annotation",
                start_index: 0,
                end_index: 7,
              },
            ],
          },
        ],
      },
    ],
    citations: [
      "https://user:password@example.com/private",
      "javascript:alert(1)",
      "https://example.com/source",
    ],
    inline_citations: [{ start_index: 0, end_index: 7, url: "https://example.com/source" }],
    usage: {
      input_tokens: 120,
      output_tokens: 40,
      server_side_tool_usage_details: {
        web_search_calls: 1,
        x_search_calls: 2,
        x_posts_fetched: 44,
        x_users_fetched: 3,
      },
    },
  };
});

it.each(["native", "manifest"] as const)(
  "runs actual web_search through a qualified %s Responses offer",
  async (kind) => {
    routeKind = kind;
    catalog = catalogFixture();
    const result = await execute();
    expect(result.details).toMatchObject({
      kind: "answer",
      provider: "clawrouter",
      query: "synthetic query",
      content: expect.stringContaining("Example answer."),
      citations: [{ url: "https://example.com/source" }],
      externalContent: { untrusted: true, wrapped: true, provider: "clawrouter" },
    });
    expect(JSON.stringify(result)).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    for (const omitted of [
      "inlineCitations",
      "x_posts_fetched",
      "password",
      "synthetic-router-key",
      "synthetic-unrelated-xai",
    ]) {
      expect(JSON.stringify(result)).not.toContain(omitted);
    }
    const body = {
      model: "grok-4.7",
      input: [{ role: "user", content: "synthetic query" }],
      tools: [{ type: "web_search" }],
      store: false,
      reasoning: { effort: "low" },
    };
    expect(requests).toEqual([
      {
        path: "/v1/catalog",
        authorization: "Bearer synthetic-router-key",
        upstreamKey: undefined,
        body: undefined,
      },
      {
        path: catalog.providers[0]!.offers[0]!.route,
        authorization: "Bearer synthetic-router-key",
        upstreamKey: undefined,
        body: kind === "manifest" ? { body } : body,
      },
    ]);
  },
  10_000,
);

it.each([
  [
    "denied model",
    (provider: ReturnType<typeof catalogFixture>["providers"][number]) => {
      provider.offers[0]!.eligible = false;
    },
  ],
  [
    "missing tool admission",
    (provider: ReturnType<typeof catalogFixture>["providers"][number]) => {
      Reflect.deleteProperty(provider.offers[0]!, "hostedToolAdmission");
    },
  ],
  [
    "unpriced tool",
    (provider: ReturnType<typeof catalogFixture>["providers"][number]) => {
      provider.offers[0]!.hostedToolAdmission.web_search = "pricing_required";
    },
  ],
  [
    "unknown admission version",
    (provider: ReturnType<typeof catalogFixture>["providers"][number]) => {
      provider.offers[0]!.hostedToolAdmission.version = "future";
    },
  ],
  [
    "unknown model",
    (provider: ReturnType<typeof catalogFixture>["providers"][number]) => {
      provider.models[0]!.upstream = "grok-unqualified";
    },
  ],
  [
    "unsupported effort",
    (provider: ReturnType<typeof catalogFixture>["providers"][number]) => {
      provider.models[0]!.supportedReasoningEfforts = ["high"];
    },
  ],
  [
    "missing native tool",
    (provider: ReturnType<typeof catalogFixture>["providers"][number]) => {
      provider.models[0]!.nativeCapabilities.endpoints.responses.hostedTools = [];
    },
  ],
] as const)("does not dispatch %s, even with an unrelated native key", async (_, mutate) => {
  mutate(catalog.providers[0]!);
  expect((await execute()).details).toMatchObject({ kind: "error", provider: "clawrouter" });
  expect(requests.map((request) => request.path)).toEqual(["/v1/catalog"]);
});

it("refreshes catalog admission and credentials for the next actual tool invocation", async () => {
  await execute();
  catalog.providers[0]!.offers[0]!.hostedToolAdmission.web_search = "pricing_required";
  expect((await execute("synthetic-rotated-router")).details).toMatchObject({ kind: "error" });
  expect(requests.map((request) => request.path)).toEqual([
    "/v1/catalog",
    "/v1/native/xai/v1/responses",
    "/v1/catalog",
  ]);
  expect(requests.at(-1)?.authorization).toBe("Bearer synthetic-rotated-router");
});

it.each(["incomplete", "failed", "in_progress"])(
  "does not present %s work as a completed answer or replay it",
  async (status) => {
    reply.status = status;
    expect((await execute()).details).toMatchObject({ kind: "error" });
    expect(requests).toHaveLength(2);
  },
);

it("refuses paid POST redirects without replaying the search", async () => {
  replyStatus = 307;
  expect((await execute()).details).toMatchObject({ kind: "error" });
  expect(requests).toHaveLength(2);
});

it("preserves caller cancellation before catalog admission", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller cancelled"));
  await expect(execute(undefined, controller.signal)).rejects.toThrow("caller cancelled");
  expect(requests).toHaveLength(0);
});
