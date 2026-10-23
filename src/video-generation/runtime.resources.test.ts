import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { acquirePluginRegistryForInspection, loadPluginRegistryHandle } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { generateVideo, type GenerateVideoParams } from "./runtime.js";
import type { VideoGenerationRequest } from "./types.js";

const videoBytes = Buffer.from("synthetic video bytes 42");
const openResource = { database: { isOpen: true }, disposals: 0 };
const closedResource = { database: { isOpen: false }, disposals: 1 };
type Mode = "buffer" | "url" | "reject";
function fixtureFor(id: string, outcome: Mode, holdLookup = false, deliveryUrl?: string) {
  const dir = makePluginLoaderTempDir();
  const key = `__openclaw_video_resources_${path.basename(dir)}`;
  const lookupStarted = createDeferredCore();
  const lookupResume = createDeferredCore();
  if (!holdLookup) {
    lookupResume.resolve();
  }
  const started = createDeferredCore();
  const resume = createDeferredCore();
  const connections: Array<{
    database: DatabaseSync;
    disposals: number;
    requests: VideoGenerationRequest[];
  }> = [];
  const state = { connections, lookupStarted, lookupResume, started, resume };
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: { ...state, videoBytes, deliveryUrl },
  });
  const plugin = writePlugin({
    dir,
    id,
    registration: `    const { DatabaseSync } = require("node:sqlite");
    const state = globalThis[${JSON.stringify(key)}];
    const database = new DatabaseSync(":memory:");
    const connection = { database, disposals: 0, requests: [] };
    state.connections.push(connection);
    const read = () => database.prepare("SELECT 42 AS value").get().value;
    api.lifecycle.registerRuntimeLifecycle({
      id: "native-video-resource",
      dispose() {
        read();
        connection.disposals++;
        database.close();
      },
    });
    api.registerVideoGenerationProvider({
      id: ${JSON.stringify(id)},
      aliases: [${JSON.stringify(`${id}-alias`)}],
      defaultModel: "fixture-model",
      capabilities: {},
      async resolveModelCapabilities() {
        read();
        state.lookupStarted.resolve();
        await state.lookupResume.promise;
        read();
        return {};
      },
      async generateVideo(request) {
        connection.requests.push(request);
        read();
        state.started.resolve();
        await state.resume.promise;
        read();
        if (${JSON.stringify(outcome)} === "reject") throw new Error("native video generation failed");
        return {
          videos: [{
            ...(${JSON.stringify(outcome)} === "url" ? { url: state.deliveryUrl } : { buffer: state.videoBytes }),
            mimeType: "video/mp4", fileName: "native.mp4",
          }],
          metadata: { get nativeValue() { return read(); } },
        };
      },
    });`,
  });
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      contracts: { videoGenerationProviders: [id] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  return {
    plugin,
    dir,
    ...state,
    release() {
      lookupResume.resolve();
      resume.resolve();
    },
    cleanup() {
      for (const { database } of connections) {
        if (database.isOpen) {
          database.close();
        }
      }
      Reflect.deleteProperty(globalThis, key);
    },
  };
}

const settle = <T>(operation: Promise<T>) =>
  operation.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );

const waitForStart = (started: Promise<void>, operation: Promise<unknown>) =>
  Promise.race([
    started,
    operation.then(() => {
      throw new Error("Video operation settled before invoking the native provider");
    }),
  ]);

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

const scenarios = [
  ["cold buffer", "buffer", "cold", "none"],
  ["cold URL", "url", "cold", "none"],
  ["cold rejection", "reject", "cold", "none"],
  ["managed host", "buffer", "managed", "none"],
  ["raw host", "buffer", "raw", "none"],
  ["override selection", "buffer", "cold", "override"],
  ["fallback selection", "buffer", "cold", "fallback"],
] as const;
type Scenario = readonly [
  name: string,
  mode: Mode,
  owner: "cold" | "managed" | "raw",
  selection: "none" | "override" | "fallback",
];
async function exercise([, mode, owner, selection]: Scenario, deliveryUrl?: string) {
  const first = selection === "none" ? undefined : fixtureFor("first", "reject");
  const fixture = fixtureFor(first ? "second" : "native", mode, owner === "managed", deliveryUrl);
  first?.resume.resolve();
  const plugins = first ? [first.plugin, fixture.plugin] : [fixture.plugin];
  const cfg: OpenClawConfig = {
    plugins: {
      allow: plugins.map((plugin) => plugin.id),
      load: { paths: plugins.map((plugin) => plugin.file) },
      slots: { memory: "none" },
    },
  };
  if (first) {
    const video = { primary: "first/fixture-model", fallbacks: ["second-alias/fixture-model"] };
    cfg.agents = { defaults: { mediaModels: { video } } };
  }
  const params: GenerateVideoParams = {
    cfg,
    prompt: "synthetic native video resource proof",
    autoProviderFallback: false,
    modelOverride:
      selection === "fallback" ? undefined : `${fixture.plugin.id}-alias/fixture-model`,
    timeoutMs: 12_345,
    providerOptions: { seed: 42 },
  };
  const env = {
    OPENCLAW_HOME: fixture.dir,
    OPENCLAW_STATE_DIR: fixture.dir,
    OPENCLAW_CONFIG_PATH: path.join(fixture.dir, "config.json"),
  };
  try {
    await withEnvAsync(env, async () => {
      useNoBundledPlugins();
      const inspection =
        owner === "managed" ? await acquirePluginRegistryForInspection({ config: cfg }) : undefined;
      const registry =
        inspection?.registry ??
        (owner === "raw" ? loadPluginRegistryHandle({ config: cfg }) : undefined);
      const run = () => generateVideo(params);
      const outcome = settle(registry ? withPluginRuntimeRegistryScope(registry, run) : run());
      try {
        const ready = owner === "managed" ? fixture.lookupStarted : fixture.started;
        await waitForStart(ready.promise, outcome);
        expect(fixture.connections).toHaveLength(1);
        const connection = fixture.connections[0]!;
        expect(connection).toMatchObject(openResource);
        await inspection?.release();
        expect(connection.database.isOpen).toBe(true);
        fixture.lookupResume.resolve();
        await waitForStart(fixture.started.promise, outcome);
        expect(connection.database.isOpen).toBe(true);
        if (first) {
          expect(first.connections).toHaveLength(1);
          expect(first.connections[0]!.requests).toHaveLength(selection === "override" ? 0 : 1);
          expect(first.connections[0]!.database.isOpen).toBe(true);
        }
        fixture.resume.resolve();
        const result = await outcome;
        if (mode === "reject") {
          expect(String(result.error)).toContain("native video generation failed");
        } else {
          expect(result.error).toBeUndefined();
          if (mode === "url") {
            expect(result.value?.videos[0]).toMatchObject({
              url: deliveryUrl,
            });
            expect(result.value?.videos[0]?.buffer).toBeUndefined();
          } else {
            expect(result.value?.videos[0]?.buffer).toEqual(videoBytes);
          }
          expect(result.value?.metadata).toEqual({ nativeValue: 42 });
          if (first) {
            expect(result.value?.provider).toBe("second-alias");
            expect(result.value?.attempts).toHaveLength(selection === "override" ? 0 : 1);
          }
        }
        expect(connection.requests[0]).toMatchObject({
          provider: first ? "second-alias" : "native-alias",
          timeoutMs: 12_345,
          providerOptions: { seed: 42 },
        });
        expect(connection).toMatchObject(owner === "raw" ? openResource : closedResource);
        if (first) {
          expect(first.connections[0]).toMatchObject(closedResource);
        }
        if (mode === "url") {
          const response = await fetch(deliveryUrl!);
          expect(response.status).toBe(200);
          expect(Buffer.from(await response.arrayBuffer())).toEqual(videoBytes);
        }
      } finally {
        first?.release();
        fixture.release();
        await outcome;
        await inspection?.release();
      }
    });
  } finally {
    first?.cleanup();
    fixture.cleanup();
  }
}

it.each<Scenario>(scenarios)("keeps resources alive for %s", async (...scenario) => {
  if (scenario[1] === "url") {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "video/mp4" });
        response.end(videoBytes);
      },
      (baseUrl) => exercise(scenario, `${baseUrl}/generated.mp4`),
    );
  } else {
    await exercise(scenario);
  }
});
