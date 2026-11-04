import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { acquirePluginRegistryForInspection } from "../../plugins/loader.js";
import {
  writePlugin,
  resetPluginLoaderTestStateForTest,
} from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { UnifiedModelCatalogProviderContext } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { resetGeneratedMediaTaskActivityForTests } from "../media-generation-activity.test-support.js";
import { prepareWorkspaceBuildGroup } from "../prepared-model-runtime.facts.js";
import { discardPreparedPluginGeneration } from "../prepared-model-runtime.plugin-lifetime.js";
import { snapshot } from "./media-resource-fixtures.test-support.js";
import { createVideoGenerateTool } from "./video-generate-tool.js";

const MODEL = "alibaba/wan2.6-t2v";
const CREATE = "/api/v1/services/aigc/video-generation/video-synthesis";
const TASK = "wan_fixture";
const JOB = "synthetic_original_job";
const VIDEO = "https://media.example/wan-fixture.mp4";
function catalog(routeKind: "native" | "manifest" = "native") {
  return {
    version: "clawrouter.client-catalog.v1",
    observedAt: new Date().toISOString(),
    scope: { authType: "proxy_key", credentialId: "synthetic-video-grant" },
    providers: [
      {
        id: "alibaba",
        allowed: true,
        executable: true,
        nativeBaseUrl: "/v1/native/alibaba",
        routes: [
          {
            endpoint: "video",
            path: CREATE,
            methods: ["POST"],
            requestFormat: "dashscope.video_create",
            responseFormat: "dashscope.video",
          },
          {
            endpoint: "task",
            path: "/api/v1/tasks/${task_id}",
            methods: ["GET"],
            requestFormat: "dashscope.video_get",
            responseFormat: "dashscope.video",
          },
        ],
        models: [{ id: MODEL, upstream: "wan2.6-t2v", capabilities: ["media.predict"] }],
        offers: [
          {
            endpoint: "video",
            modelId: MODEL,
            transport: "http",
            routeKind,
            route:
              routeKind === "native" ? "/v1/native/alibaba" + CREATE : "/v1/proxy/alibaba/video",
            eligible: true,
            affordability: "request-dependent",
          },
        ],
      },
    ],
  };
}
const pending = () => ({
  output: {
    task_id: TASK,
    task_status: "RUNNING",
    video_url: "https://media.example/not-final.mp4",
  },
});
const complete = () => ({ output: { task_id: TASK, task_status: "SUCCEEDED", video_url: VIDEO } });
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let http: Awaited<ReturnType<typeof reserveTestPortListener<ReturnType<typeof createServer>>>>;
let acquired: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>;
let prepared: Awaited<ReturnType<typeof prepareWorkspaceBuildGroup>>;
let tool: NonNullable<ReturnType<typeof createVideoGenerateTool>>;
let config: OpenClawConfig;
let inventory = catalog();
let submitted: unknown, observation: unknown;
let status = 200,
  alternateCalls = 0;
let hold: "headers" | "body" | "poll" | "disconnect" | undefined;
let held = createDeferredCore(),
  heldResponse: ServerResponse | undefined;
let returnedJob: string | undefined = JOB;
const calls: Array<{ path: string; method?: string; headers: IncomingHttpHeaders; body: unknown }> =
  [];
const posts = () => calls.filter((call) => call.method === "POST");
const reads = () =>
  calls.filter(
    (call) => call.method === "GET" && call.path !== "/v1/catalog" && call.path !== "/alternate",
  );
const execute = (args: Record<string, unknown> = {}, signal?: AbortSignal) =>
  withPluginRuntimeRegistryScope(acquired.registry, () =>
    tool.execute(
      "wan-fixture",
      {
        prompt: "A synthetic quiet landscape",
        size: "1280*720",
        durationSeconds: 5,
        ...args,
      },
      signal,
    ),
  );

beforeAll(async () => {
  state = await createOpenClawTestState({
    label: "clawrouter-video-host",
    env: {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      CLAWROUTER_API_KEY: undefined,
      MODELSTUDIO_API_KEY: "synthetic-native-key-not-router",
      DASHSCOPE_API_KEY: undefined,
      QWEN_API_KEY: undefined,
    },
  });
  http = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          const raw = await buffer(request);
          calls.push({
            path: request.url ?? "",
            method: request.method,
            headers: request.headers,
            body: raw.length ? JSON.parse(raw.toString("utf8")) : undefined,
          });
          response.setHeader("Content-Type", "application/json");
          if (request.url === "/v1/catalog") {
            response.end(JSON.stringify(inventory));
            return;
          }
          if (request.url === "/alternate") {
            alternateCalls++;
            response.end("{}");
            return;
          }
          if (hold === "disconnect") {
            response.destroy();
            return;
          }
          if (returnedJob) {
            response.setHeader("x-clawrouter-job-id", returnedJob);
          }
          if (
            hold === "headers" ||
            hold === "body" ||
            (hold === "poll" && request.method === "GET")
          ) {
            heldResponse = response;
            if (hold === "body") {
              response.writeHead(200);
              response.write('{"output":');
            }
            held.resolve();
            return;
          }
          response.statusCode = status;
          const value = request.method === "POST" ? submitted : observation;
          response.end(typeof value === "string" ? value : JSON.stringify(value));
        })().catch((error: unknown) =>
          response.destroy(error instanceof Error ? error : undefined),
        );
      }),
  });
  const baseUrl = `http://127.0.0.1:${http.claim.port}`;
  const alternate = writePlugin({
    id: "video-alternate-fixture",
    dir: state.statePath("alternate"),
    registration: `api.registerVideoGenerationProvider({ id: "video-alternate-fixture", defaultModel: "fixture", capabilities: {}, async generateVideo() {
      await fetch(${JSON.stringify(baseUrl + "/alternate")}); return { videos: [{ url: "https://media.example/alternate.mp4", mimeType: "video/mp4" }] };
    } });`,
  });
  await state.writeJson("alternate/openclaw.plugin.json", {
    id: alternate.id,
    contracts: { videoGenerationProviders: [alternate.id] },
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  });
  await state.writeAuthProfiles({
    version: 1,
    profiles: {
      "clawrouter:video": { type: "api_key", provider: "clawrouter", key: "synthetic-router-key" },
      "alibaba:native": {
        type: "api_key",
        provider: "alibaba",
        key: "synthetic-native-profile-not-router",
      },
    },
  });
  config = {
    plugins: {
      allow: ["clawrouter", alternate.id],
      entries: { clawrouter: { enabled: true } },
      load: { paths: [alternate.file] },
      slots: { memory: "none" },
    },
    models: {
      providers: {
        clawrouter: {
          baseUrl,
          apiKey: "clawrouter:video",
          models: [],
          headers: {
            "x-dashscope-api-key": "synthetic-must-not-forward",
            "x-clawrouter-job-id": "foreign-configured-selector",
          },
        },
      },
    },
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        mediaModels: {
          video: {
            primary: `clawrouter/${MODEL}`,
            fallbacks: [`${alternate.id}/fixture`],
          },
        },
      },
    },
  };
  acquired = await acquirePluginRegistryForInspection({ config });
  prepared = await prepareWorkspaceBuildGroup(
    [
      {
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        config,
        skipCredentials: true,
      },
    ],
    "static",
    { includeCredentialProviders: false },
    () => acquired.registry,
  );
  const created = createVideoGenerateTool({
    config,
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    preparedModelRuntime: snapshot(prepared),
  });
  expect(created).not.toBeNull();
  tool = created!;
});
beforeEach(() => {
  inventory = catalog();
  submitted = pending();
  observation = complete();
  status = 200;
  hold = undefined;
  held = createDeferredCore();
  heldResponse = undefined;
  returnedJob = JOB;
  alternateCalls = calls.length = 0;
});
afterEach(() => {
  heldResponse?.destroy();
  resetGeneratedMediaTaskActivityForTests();
});
afterAll(async () => {
  if (prepared) {
    await discardPreparedPluginGeneration(prepared.pluginGeneration);
  }
  await acquired?.release();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  if (http) {
    http.listener.closeAllConnections();
    await http.releaseListener();
    await http.claim.release();
  }
  await state?.cleanup();
});

it.each(["native", "manifest"] as const)(
  "runs actual video_generate over %s without output-host credentials",
  async (routeKind) => {
    inventory = catalog(routeKind);
    const result = await execute({ watermark: true });
    expect(posts()).toHaveLength(1);
    expect(reads()).toHaveLength(1);
    expect(posts()[0]?.path).toBe(
      routeKind === "native" ? "/v1/native/alibaba" + CREATE : "/v1/proxy/alibaba/video",
    );
    const body = {
      model: "wan2.6-t2v",
      input: { prompt: "A synthetic quiet landscape" },
      parameters: { size: "1280*720", duration: 5, watermark: true },
    };
    expect(posts()[0]?.body).toEqual(routeKind === "native" ? body : { body });
    expect(posts()[0]?.headers["x-clawrouter-job-id"]).toBeUndefined();
    expect(posts()[0]?.headers["x-dashscope-async"]).toBe("enable");
    expect(posts()[0]?.headers.authorization).toBe("Bearer synthetic-router-key");
    expect(reads()[0]).toMatchObject({
      path:
        routeKind === "native"
          ? `/v1/native/alibaba/api/v1/tasks/${TASK}`
          : `/v1/proxy/alibaba/task?task_id=${TASK}`,
      method: "GET",
      body: undefined,
      headers: { authorization: "Bearer synthetic-router-key", "x-clawrouter-job-id": JOB },
    });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.headers["x-dashscope-api-key"]).toBeUndefined();
    }
    expect(JSON.stringify(result)).toContain(VIDEO);
    expect(JSON.stringify(result)).not.toContain("not-final");
    expect(alternateCalls).toBe(0);
  },
);

it.each([
  "missing output",
  "foreign task",
  "unknown observation",
  "HTTP error",
  "malformed JSON",
  "missing job",
  "transport uncertainty",
  "oversize JSON",
  "unsafe output",
])("does not replay possibly paid creation after %s", async (failure) => {
  if (failure === "missing output") {
    observation = { output: { task_id: TASK, task_status: "SUCCEEDED" } };
  }
  if (failure === "foreign task") {
    observation = { output: { task_id: "foreign", task_status: "SUCCEEDED", video_url: VIDEO } };
  }
  if (failure === "unknown observation") {
    observation = { output: { task_id: TASK, task_status: "UNKNOWN" } };
  }
  if (failure === "HTTP error") {
    status = 502;
  }
  if (failure === "malformed JSON") {
    submitted = '{"output":';
  }
  if (failure === "missing job") {
    returnedJob = undefined;
  }
  if (failure === "transport uncertainty") {
    hold = "disconnect";
  }
  if (failure === "oversize JSON") {
    submitted = JSON.stringify({ padding: "x".repeat(1024 * 1024), ...pending() });
  }
  if (failure === "unsafe output") {
    observation = {
      output: {
        task_id: TASK,
        task_status: "SUCCEEDED",
        video_url: "http://media.example/video.mp4",
      },
    };
  }
  await expect(execute()).rejects.toThrow();
  expect(posts()).toHaveLength(1);
  expect(reads().length).toBeLessThanOrEqual(1);
  expect(alternateCalls).toBe(0);
});
it.each(["before", "headers", "body", "poll"] as const)(
  "propagates caller cancellation at %s with no alternate attempt",
  async (phase) => {
    const controller = new AbortController();
    if (phase === "before") {
      controller.abort(new Error("caller stopped video"));
    } else {
      hold = phase;
    }
    const outcome = execute({}, controller.signal),
      rejected = expect(outcome).rejects.toThrow();
    if (phase !== "before") {
      await Promise.race([
        held.promise,
        outcome.then(() => {
          throw new Error("Operation settled before held response");
        }),
      ]);
      controller.abort(new Error("caller stopped video"));
    }
    await rejected;
    expect(posts()).toHaveLength(phase === "before" ? 0 : 1);
    expect(alternateCalls).toBe(0);
  },
);
it("keeps fallback usable after a proven pre-egress failure", async () => {
  inventory.providers[0]!.offers = [];
  await execute();
  expect(posts()).toHaveLength(0);
  expect(alternateCalls).toBe(1);
});
it.each(["\ud800", "x".repeat(1501)])("rejects invalid prompt before creation", async (prompt) => {
  await expect(execute({ prompt, model: `clawrouter/${MODEL}` })).rejects.toThrow();
  expect(posts()).toHaveLength(0);
});
it.each([
  "stale",
  "foreign scope",
  "foreign model",
  "wrong format",
  "missing control",
  "wrong control method",
])("denies %s before creation", async (failure) => {
  if (failure === "stale") {
    inventory.observedAt = "2000-01-01T00:00:00Z";
  }
  if (failure === "foreign scope") {
    inventory.scope.authType = "access";
  }
  if (failure === "foreign model") {
    inventory.providers[0]!.models[0]!.upstream = "wan2.6-i2v";
  }
  if (failure === "wrong format") {
    inventory.providers[0]!.routes[0]!.requestFormat = "unknown.video";
  }
  if (failure === "missing control") {
    inventory.providers[0]!.routes.pop();
  }
  if (failure === "wrong control method") {
    inventory.providers[0]!.routes[1]!.methods = ["POST"];
  }
  await expect(execute({ model: `clawrouter/${MODEL}` })).rejects.toThrow();
  expect(posts()).toHaveLength(0);
});

it("lists only freshly qualified offers through the registered video catalog", async () => {
  const selected = acquired.registry.modelCatalogProviders.find(
    (entry) =>
      entry.provider.provider === "clawrouter" && entry.provider.kinds.includes("video_generation"),
  )!.provider;
  const resolveAuth = () => ({
    profileId: "clawrouter:video",
    mode: "api_key" as const,
    source: "env" as const,
  });
  const context: UnifiedModelCatalogProviderContext = {
    config,
    env: {},
    includeLive: true,
    agentDir: state.agentDir(),
    resolveProviderApiKey: resolveAuth,
    resolveProviderAuth: resolveAuth,
  };
  const rows = await selected.liveCatalog!(context);
  expect(rows?.map((row) => [row.kind, row.model, row.default])).toEqual([
    ["video_generation", MODEL, undefined],
  ]);
  expect(rows?.[0]).not.toHaveProperty("cost");
  inventory.providers[0]!.routes.pop();
  await expect(selected.liveCatalog!(context)).resolves.toEqual([]);
  await expect(
    selected.liveCatalog!({
      ...context,
      resolveProviderAuth: () => ({ ...resolveAuth(), profileId: "alibaba:native" }),
    }),
  ).rejects.toThrow();
  expect(posts()).toHaveLength(0);
});
