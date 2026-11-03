import fs from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as mediaStore from "../../media/store.js";
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
import { createMusicGenerateTool } from "./music-generate-tool.js";

const CLIP = "google/lyria-3-clip-preview";
const PRO = "google/lyria-3-pro-preview";
const nativePath = (model = CLIP) =>
  `/v1/native/google-gemini/v1beta/models/${model.slice(7)}:generateContent`;
const manifestPath = "/v1/proxy/google-gemini/music_generate";
function catalog(routeKind: "native" | "manifest" = "native") {
  return {
    version: "clawrouter.client-catalog.v1",
    observedAt: new Date().toISOString(),
    scope: { authType: "proxy_key", credentialId: "synthetic-music-grant" },
    providers: [
      {
        id: "google-gemini",
        allowed: true,
        executable: true,
        nativeBaseUrl: "/v1/native/google-gemini",
        routes: [
          {
            endpoint: "music_generate",
            path: "/v1beta/models/${model}:generateContent",
            methods: ["POST"],
            requestFormat: "google.music_generate",
            responseFormat: "google.music",
          },
        ],
        models: [CLIP, PRO].map((id) => ({
          id,
          upstream: id.slice(7),
          capabilities: ["audio.generate"],
        })),
        offers: [CLIP, PRO].map((modelId) => ({
          endpoint: "music_generate",
          modelId,
          transport: "http",
          routeKind,
          route:
            routeKind === "native"
              ? "/v1/native/google-gemini/v1beta/models/${model}:generateContent"
              : manifestPath,
          eligible: true,
          affordability: "request-dependent",
        })),
      },
    ],
  };
}
function wav() {
  const bytes = Buffer.alloc(1808);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(44100, 24);
  bytes.writeUInt32LE(176400, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
function payload(bytes: Buffer, mimeType = "audio/mpeg") {
  return {
    candidates: [
      {
        finishReason: "STOP",
        content: {
          role: "model",
          parts: [
            { text: "Synthetic lyrics" },
            { inlineData: { mimeType, data: bytes.toString("base64") } },
          ],
        },
      },
    ],
    usageMetadata: { totalTokenCount: 16 },
  };
}

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let http: Awaited<ReturnType<typeof reserveTestPortListener<ReturnType<typeof createServer>>>>;
let acquired: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>;
let prepared: Awaited<ReturnType<typeof prepareWorkspaceBuildGroup>>;
let tool: NonNullable<ReturnType<typeof createMusicGenerateTool>>;
let config: OpenClawConfig;
let mp3: Buffer;
let inventory = catalog();
let output: unknown;
let status = 200;
let hold: "headers" | "body" | "disconnect" | undefined;
let held = createDeferredCore();
let heldResponse: ServerResponse | undefined;
let alternateCalls = 0;
let completed = 0;
const calls: Array<{ path: string; method?: string; headers: IncomingHttpHeaders; body: unknown }> =
  [];
const posts = () => calls.filter((call) => call.method === "POST");
const execute = (args: Record<string, unknown> = {}, signal?: AbortSignal) =>
  withPluginRuntimeRegistryScope(acquired.registry, () =>
    tool.execute("lyria-fixture", { prompt: "A synthetic melody", ...args }, signal),
  );

beforeAll(async () => {
  state = await createOpenClawTestState({
    label: "clawrouter-music-host",
    env: {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      CLAWROUTER_API_KEY: undefined,
      GOOGLE_API_KEY: "synthetic-native-key-must-not-be-used",
      GEMINI_API_KEY: undefined,
    },
  });
  // Offline silence from ClawRouter PR665; no generated vendor recording.
  mp3 = await fs.readFile(
    new URL("../../../test/fixtures/media/lyria-silence.mp3", import.meta.url),
  );
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
          if (hold) {
            heldResponse = response;
            if (hold === "body") {
              response.writeHead(200);
              response.write('{"candidates":[');
            }
            held.resolve();
            return;
          }
          response.statusCode = status;
          response.once("finish", () => {
            completed++;
          });
          response.end(typeof output === "string" ? output : JSON.stringify(output));
        })().catch((error: unknown) =>
          response.destroy(error instanceof Error ? error : undefined),
        );
      }),
  });
  const baseUrl = `http://127.0.0.1:${http.claim.port}`;
  const alternate = writePlugin({
    id: "music-alternate-fixture",
    dir: state.statePath("alternate"),
    registration: `api.registerMusicGenerationProvider({ id: "music-alternate-fixture", defaultModel: "fixture", capabilities: {},
      async generateMusic() { await fetch(${JSON.stringify(baseUrl + "/alternate")}); return { tracks: [{ buffer: Buffer.from(${JSON.stringify(mp3.toString("base64"))}, "base64"), mimeType: "audio/mpeg" }] }; }
    });`,
  });
  await state.writeJson("alternate/openclaw.plugin.json", {
    id: alternate.id,
    contracts: { musicGenerationProviders: [alternate.id] },
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  });
  await state.writeAuthProfiles({
    version: 1,
    profiles: {
      "clawrouter:music": { type: "api_key", provider: "clawrouter", key: "synthetic-router-key" },
      "google:native": {
        type: "api_key",
        provider: "google",
        key: "synthetic-native-profile-not-used",
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
          apiKey: "clawrouter:music",
          models: [],
          headers: { "x-goog-api-key": "synthetic-forbidden-header" },
        },
      },
    },
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        mediaModels: {
          music: {
            primary: `clawrouter/${CLIP}`,
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
  const preparedRuntime = snapshot(prepared);
  const created = createMusicGenerateTool({
    config,
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    preparedModelRuntime: preparedRuntime,
  });
  expect(created).not.toBeNull();
  tool = created!;
});
beforeEach(() => {
  inventory = catalog();
  output = payload(mp3);
  status = 200;
  hold = undefined;
  held = createDeferredCore();
  heldResponse = undefined;
  alternateCalls = completed = calls.length = 0;
});
afterEach(() => {
  heldResponse?.destroy();
  vi.restoreAllMocks();
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
  "runs the actual music tool through %s with proxy-only credentials",
  async (routeKind) => {
    inventory = catalog(routeKind);
    const save = vi.spyOn(mediaStore, "saveMediaBuffer");
    await execute({ lyrics: "Synthetic lyrics", instrumental: true });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.path).toBe(routeKind === "native" ? nativePath() : manifestPath);
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "A synthetic melody\n\nInstrumental only. No vocals, no sung lyrics, no spoken word.\n\nLyrics:\nSynthetic lyrics",
            },
          ],
        },
      ],
      generationConfig: { responseModalities: ["AUDIO", "TEXT"] },
    };
    expect(posts()[0]?.body).toEqual(
      routeKind === "manifest" ? { body, pathParams: { model: "lyria-3-clip-preview" } } : body,
    );
    for (const call of calls) {
      expect(call.headers.authorization).toBe("Bearer synthetic-router-key");
      expect(call.headers["x-goog-api-key"]).toBeUndefined();
      expect(call.headers["x-api-key"]).toBeUndefined();
    }
    expect(save.mock.calls[0]?.[0]).toEqual(mp3);
    expect(alternateCalls).toBe(0);
  },
);

it("returns Pro WAV bytes without promising or serializing an output format", async () => {
  const audio = wav();
  output = payload(audio, "audio/wav");
  const save = vi.spyOn(mediaStore, "saveMediaBuffer");
  await execute({ model: `clawrouter/${PRO}`, format: "wav" });
  expect(posts()[0]?.path).toBe(nativePath(PRO));
  expect(save.mock.calls[0]?.[0]).toEqual(audio);
  expect(JSON.stringify(posts()[0]?.body)).not.toContain("wav");
});

it("serializes an actual host-loaded reference image inline without a remote asset URL", async () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQI12NkYPj/n4GBgYGJAQoAHRkCAhxhMhsAAAAASUVORK5CYII=";
  const file = `${state.workspaceDir}/lyria-reference.png`;
  await fs.writeFile(file, Buffer.from(png, "base64"));
  await execute({ image: file });
  expect(posts()).toHaveLength(1);
  expect(posts()[0]?.body).toMatchObject({
    contents: [
      {
        parts: [
          { text: "A synthetic melody" },
          { inlineData: { mimeType: "image/png", data: png } },
        ],
      },
    ],
  });
});

it("publishes fresh entitled music offers through the registered catalog without pricing defaults", async () => {
  const selected = acquired.registry.modelCatalogProviders.find(
    (entry) =>
      entry.provider.provider === "clawrouter" && entry.provider.kinds.includes("music_generation"),
  )!.provider;
  const resolveAuth = () => ({
    apiKey: undefined,
    profileId: "clawrouter:music",
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
    ["music_generation", CLIP, undefined],
    ["music_generation", PRO, undefined],
  ]);
  inventory.providers[0]!.offers = [];
  await expect(selected.liveCatalog!(context)).resolves.toEqual([]);
  inventory = catalog();
  inventory.scope.authType = "admin";
  await expect(selected.liveCatalog!(context)).rejects.toThrow("scope");
  expect(posts()).toHaveLength(0);
});

it("does not repeat generation when local asset persistence fails after EOF", async () => {
  vi.spyOn(mediaStore, "saveMediaBuffer").mockRejectedValueOnce(
    new Error("synthetic disk failure"),
  );
  await expect(execute()).rejects.toThrow("synthetic disk failure");
  expect(posts()).toHaveLength(1);
  expect(completed).toBe(1);
  expect(alternateCalls).toBe(0);
});

it("keeps the configured alternate usable when no paid POST was attempted", async () => {
  inventory.providers[0]!.offers = [];
  await execute();
  expect(posts()).toHaveLength(0);
  expect(alternateCalls).toBe(1);
});

it.each([
  "text-only",
  "malformed JSON",
  "ambiguous",
  "bad base64",
  "HTTP error",
  "transport uncertainty",
])("never buys another provider attempt after %s", async (failure) => {
  if (failure === "text-only") {
    output = {
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "lyrics only" }] } }],
    };
  }
  if (failure === "malformed JSON") {
    output = '{"candidates":';
  }
  if (failure === "ambiguous") {
    output = { candidates: [...payload(mp3).candidates, ...payload(mp3).candidates] };
  }
  if (failure === "bad base64") {
    output = {
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ inlineData: { data: "ZE==", mimeType: "audio/mpeg" } }] },
        },
      ],
    };
  }
  if (failure === "HTTP error") {
    status = 502;
  }
  if (failure === "transport uncertainty") {
    hold = "disconnect";
  }
  await expect(execute()).rejects.toThrow();
  expect(posts()).toHaveLength(1);
  expect(alternateCalls).toBe(0);
});

it.each(["before", "headers", "body", "after EOF"] as const)(
  "stops the real caller signal at %s without replay",
  async (phase) => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled music");
    if (phase === "before") {
      controller.abort(reason);
    }
    if (phase === "headers" || phase === "body") {
      hold = phase;
    }
    if (phase === "after EOF") {
      const save = mediaStore.saveMediaBuffer;
      vi.spyOn(mediaStore, "saveMediaBuffer").mockImplementation(async (...args) => {
        const result = await save(...args);
        controller.abort(reason);
        return result;
      });
    }
    const outcome = execute({}, controller.signal);
    const rejected = expect(outcome).rejects.toThrow();
    if (phase === "headers" || phase === "body") {
      await Promise.race([
        held.promise,
        outcome.then(() => {
          throw new Error("Settled before the held response");
        }),
      ]);
      controller.abort(reason);
    }
    await rejected;
    expect(posts()).toHaveLength(phase === "before" ? 0 : 1);
    expect(alternateCalls).toBe(0);
    if (phase === "after EOF") {
      expect(completed).toBe(1); // No compensating upstream request/refund claim.
    }
  },
);

it.each([
  "stale",
  "foreign scope",
  "wrong upstream",
  "wrong format",
  "mixed capability",
  "wrong path",
])("denies a %s offer before music POST", async (failure) => {
  if (failure === "stale") {
    inventory.observedAt = new Date(Date.now() - 61_000).toISOString();
  }
  if (failure === "foreign scope") {
    inventory.scope.authType = "admin";
  }
  if (failure === "wrong upstream") {
    inventory.providers[0]!.models[0]!.upstream = "lyria-3-pro-preview";
  }
  if (failure === "wrong format") {
    inventory.providers[0]!.routes[0]!.requestFormat = "google.generate_content";
  }
  if (failure === "mixed capability") {
    inventory.providers[0]!.models[0]!.capabilities.push("llm.generate");
  }
  if (failure === "wrong path") {
    inventory.providers[0]!.routes[0]!.path = "/v1beta/models/${model}:streamGenerateContent";
  }
  await expect(execute({ model: `clawrouter/${CLIP}` })).rejects.toThrow();
  expect(posts()).toHaveLength(0);
});
