import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
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

function createNativeVideoFixture(
  id = "native-video-owner",
  outcome: "buffer" | "url" | "reject" = "buffer",
  holdLookup = false,
  deliveryUrl?: string,
) {
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
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: { connections, lookupStarted, lookupResume, started, resume, videoBytes, deliveryUrl },
  });
  const plugin = writePlugin({
    dir,
    id,
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = {
  id: ${JSON.stringify(id)},
  register(api) {
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
    });
  },
};`,
  });
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      contracts: { videoGenerationProviders: [id] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  const config: OpenClawConfig = {
    plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
  };
  const params: GenerateVideoParams = {
    cfg: config,
    prompt: "synthetic native video resource proof",
    modelOverride: `${id}-alias/fixture-model`,
    autoProviderFallback: false,
    timeoutMs: 12_345,
    providerOptions: { seed: 42 },
  };
  return {
    plugin,
    connections,
    lookupStarted,
    lookupResume,
    started,
    resume,
    config,
    params,
    run: () => generateVideo(params),
    withEnvironment: (run: () => Promise<void>) =>
      withEnvAsync(
        {
          OPENCLAW_HOME: dir,
          OPENCLAW_STATE_DIR: dir,
          OPENCLAW_CONFIG_PATH: path.join(dir, "config.json"),
        },
        run,
      ),
    cleanup() {
      lookupResume.resolve();
      resume.resolve();
      for (const { database } of connections) {
        if (database.isOpen) {
          database.close();
        }
      }
      Reflect.deleteProperty(globalThis, key);
    },
  };
}

function settle<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
}

async function waitForProviderStart(started: Promise<void>, operation: Promise<unknown>) {
  await Promise.race([
    started,
    operation.then(() => {
      throw new Error("Video operation settled before invoking the native provider");
    }),
  ]);
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe("video generation registration resources", () => {
  it.each(["buffer", "url", "reject"] as const)(
    "releases cold video resources after %s settlement",
    async (mode) => {
      const server =
        mode === "url"
          ? createServer((_request, response) => {
              response.writeHead(200, { "content-type": "video/mp4" });
              response.end(videoBytes);
            })
          : undefined;
      let deliveryUrl: string | undefined;
      if (server) {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected fixture TCP address");
        }
        deliveryUrl = `http://127.0.0.1:${address.port}/generated.mp4`;
      }
      const fixture = createNativeVideoFixture("native-video-owner", mode, false, deliveryUrl);
      try {
        await fixture.withEnvironment(async () => {
          useNoBundledPlugins();
          const outcome = settle(fixture.run());
          try {
            await waitForProviderStart(fixture.started.promise, outcome);
            expect(fixture.connections).toHaveLength(1);
            const connection = fixture.connections[0]!;
            expect(connection.database.isOpen).toBe(true);
            expect(connection.disposals).toBe(0);
            fixture.resume.resolve();
            const result = await outcome;
            if (mode === "reject") {
              expect(String(result.error)).toContain("native video generation failed");
            } else {
              expect(result.error).toBeUndefined();
              if (mode === "url") {
                expect(result.value?.videos[0]?.url).toBe(deliveryUrl);
                expect(result.value?.videos[0]?.buffer).toBeUndefined();
              } else {
                expect(result.value?.videos[0]?.buffer).toEqual(videoBytes);
              }
              expect(result.value?.metadata).toEqual({ nativeValue: 42 });
            }
            expect(connection.requests[0]).toMatchObject({
              provider: "native-video-owner-alias",
              timeoutMs: 12_345,
              providerOptions: fixture.params.providerOptions,
            });
            expect(connection.database.isOpen).toBe(false);
            expect(connection.disposals).toBe(1);
            if (mode === "url") {
              const response = await fetch(deliveryUrl!);
              expect(response.status).toBe(200);
              expect(Buffer.from(await response.arrayBuffer())).toEqual(videoBytes);
            }
          } finally {
            fixture.lookupResume.resolve();
            fixture.resume.resolve();
            await outcome;
          }
        });
      } finally {
        fixture.cleanup();
        if (server) {
          const closed = once(server, "close");
          server.close();
          server.closeAllConnections();
          await closed;
        }
      }
    },
  );

  it.each(["managed", "raw"] as const)(
    "preserves the %s host owner through video generation",
    async (owner) => {
      const fixture = createNativeVideoFixture("native-video-owner", "buffer", owner === "managed");
      try {
        await fixture.withEnvironment(async () => {
          useNoBundledPlugins();
          const inspection =
            owner === "managed"
              ? await acquirePluginRegistryForInspection({ config: fixture.config })
              : undefined;
          const registry =
            inspection?.registry ?? loadPluginRegistryHandle({ config: fixture.config });
          const outcome = settle(withPluginRuntimeRegistryScope(registry, fixture.run));
          try {
            await waitForProviderStart(
              owner === "managed" ? fixture.lookupStarted.promise : fixture.started.promise,
              outcome,
            );
            expect(fixture.connections).toHaveLength(1);
            await inspection?.release();
            expect(fixture.connections[0]!.database.isOpen).toBe(true);
            fixture.lookupResume.resolve();
            await waitForProviderStart(fixture.started.promise, outcome);
            expect(fixture.connections[0]!.database.isOpen).toBe(true);
            fixture.resume.resolve();
            const result = await outcome;
            expect(result.error).toBeUndefined();
            expect(result.value?.videos[0]?.buffer).toEqual(videoBytes);
            expect(result.value?.metadata).toEqual({ nativeValue: 42 });
            expect(fixture.connections[0]!.database.isOpen).toBe(owner === "raw");
            expect(fixture.connections[0]!.disposals).toBe(owner === "raw" ? 0 : 1);
          } finally {
            fixture.lookupResume.resolve();
            fixture.resume.resolve();
            await outcome;
            await inspection?.release();
          }
        });
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each(["override", "fallback"] as const)(
    "retains both eligible registrations for %s selection",
    async (selection) => {
      const first = createNativeVideoFixture("first-video-owner", "reject");
      const second = createNativeVideoFixture("second-video-owner");
      first.resume.resolve();
      try {
        await second.withEnvironment(async () => {
          useNoBundledPlugins();
          const outcome = settle(
            generateVideo({
              ...second.params,
              cfg: {
                agents: {
                  defaults: {
                    mediaModels: {
                      video: {
                        primary: "first-video-owner/fixture-model",
                        fallbacks: ["second-video-owner-alias/fixture-model"],
                      },
                    },
                  },
                },
                plugins: {
                  allow: [first.plugin.id, second.plugin.id],
                  load: { paths: [first.plugin.file, second.plugin.file] },
                  slots: { memory: "none" },
                },
              },
              modelOverride: selection === "override" ? second.params.modelOverride : undefined,
            }),
          );
          try {
            await waitForProviderStart(second.started.promise, outcome);
            expect(first.connections).toHaveLength(1);
            expect(second.connections).toHaveLength(1);
            expect(first.connections[0]!.requests).toHaveLength(selection === "override" ? 0 : 1);
            expect(first.connections[0]!.database.isOpen).toBe(true);
            second.resume.resolve();
            const result = await outcome;
            expect(result.error).toBeUndefined();
            expect(result.value?.provider).toBe("second-video-owner-alias");
            expect(result.value?.videos[0]?.buffer).toEqual(videoBytes);
            expect(result.value?.attempts).toHaveLength(selection === "override" ? 0 : 1);
            for (const connection of [...first.connections, ...second.connections]) {
              expect(connection.database.isOpen).toBe(false);
              expect(connection.disposals).toBe(1);
            }
          } finally {
            second.resume.resolve();
            await outcome;
          }
        });
      } finally {
        first.cleanup();
        second.cleanup();
      }
    },
  );
});
