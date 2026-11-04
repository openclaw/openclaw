import fs from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { acquirePluginRegistryForInspection } from "../../plugins/loader.js";
import {
  writePlugin,
  resetPluginLoaderTestStateForTest,
} from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { resetGeneratedMediaTaskActivityForTests } from "../media-generation-activity.test-support.js";
import { prepareWorkspaceBuildGroup } from "../prepared-model-runtime.facts.js";
import { discardPreparedPluginGeneration } from "../prepared-model-runtime.plugin-lifetime.js";
import { snapshot } from "./media-resource-fixtures.test-support.js";
import { createMusicGenerateTool } from "./music-generate-tool.js";

/** The registered tool, runtime, plugin and guarded HTTP path shared by native music fixtures. */
export function installClawRouterMusicHostFixture<T>(options: {
  model: string;
  catalog: () => T;
  payload: (mp3: Buffer) => unknown;
  contentType?: string;
  bodyPrefix?: string;
}) {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let http: Awaited<ReturnType<typeof reserveTestPortListener<ReturnType<typeof createServer>>>>;
  let acquired: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>;
  let prepared: Awaited<ReturnType<typeof prepareWorkspaceBuildGroup>>;
  let tool: NonNullable<ReturnType<typeof createMusicGenerateTool>>;
  let config: OpenClawConfig;
  let mp3: Buffer;
  let inventory = options.catalog();
  let output: unknown;
  let status = 200;
  let hold: "headers" | "body" | "disconnect" | "catalog" | undefined;
  let held = createDeferredCore();
  let heldResponse: ServerResponse | undefined;
  let heldClosed = false;
  let bodyPrefix = options.bodyPrefix;
  let alternateCalls = 0;
  let completed = 0;
  const calls: Array<{
    path: string;
    method?: string;
    headers: IncomingHttpHeaders;
    body: unknown;
  }> = [];
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
        OPENROUTER_API_KEY: "synthetic-openrouter-key-must-not-be-used",
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
            if (request.url === "/v1/catalog" && hold !== "catalog") {
              response.end(JSON.stringify(inventory));
              return;
            }
            if (request.url === "/alternate") {
              alternateCalls++;
              response.end("{}");
              return;
            }
            response.setHeader("Content-Type", options.contentType ?? "application/json");
            if (hold === "disconnect") {
              response.destroy();
              return;
            }
            if (hold) {
              heldResponse = response;
              response.once("close", () => {
                heldClosed = true;
              });
              if (hold === "body") {
                response.writeHead(200);
                response.write(bodyPrefix ?? '{"candidates":[');
              }
              held.resolve();
              return;
            }
            response.statusCode = status;
            if (status === 307) {
              response.setHeader("Location", "/redirected");
            }
            response.once("finish", () => {
              completed++;
            });
            if (Array.isArray(output)) {
              for (const part of output) {
                response.write(part);
              }
              response.end();
            } else {
              response.end(typeof output === "string" ? output : JSON.stringify(output));
            }
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
        "clawrouter:music": {
          type: "api_key",
          provider: "clawrouter",
          key: "synthetic-router-key",
        },
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
            headers: {
              "x-goog-api-key": "synthetic-forbidden-header",
              "api-key": "synthetic-native-header",
              cookie: "synthetic=foreign",
            },
          },
        },
      },
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          mediaModels: {
            music: {
              primary: `clawrouter/${options.model}`,
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
    inventory = options.catalog();
    output = options.payload(mp3);
    status = 200;
    hold = undefined;
    held = createDeferredCore();
    heldResponse = undefined;
    heldClosed = false;
    bodyPrefix = options.bodyPrefix;
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

  return {
    calls,
    posts,
    execute,
    get state() {
      return state;
    },
    get config() {
      return config;
    },
    get acquired() {
      return acquired;
    },
    get mp3() {
      return mp3;
    },
    get inventory() {
      return inventory;
    },
    set inventory(value: T) {
      inventory = value;
    },
    get output() {
      return output;
    },
    set output(value: unknown) {
      output = value;
    },
    get status() {
      return status;
    },
    set status(value: number) {
      status = value;
    },
    get hold() {
      return hold;
    },
    set hold(value: typeof hold) {
      hold = value;
    },
    get bodyPrefix() {
      return bodyPrefix;
    },
    set bodyPrefix(value: string | undefined) {
      bodyPrefix = value;
    },
    get heldClosed() {
      return heldClosed;
    },
    get held() {
      return held;
    },
    get alternateCalls() {
      return alternateCalls;
    },
    get completed() {
      return completed;
    },
  };
}

export function musicWavFixture() {
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
