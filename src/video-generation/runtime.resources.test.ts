import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, expect, it } from "vitest";
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
const cleanups: Array<() => void | Promise<void>> = [];
const unblocks: Array<() => void> = [];
const pending: Promise<unknown>[] = [];

async function drainOperations() {
  unblocks.forEach((unblock) => unblock());
  await Promise.all(pending.splice(0));
}

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
  const state = { connections, lookupStarted, lookupResume, started, resume };
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: { ...state, videoBytes, deliveryUrl },
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
  unblocks.push(() => {
    lookupResume.resolve();
    resume.resolve();
  });
  cleanups.push(() => {
    for (const { database } of connections) {
      if (database.isOpen) {
        database.close();
      }
    }
    Reflect.deleteProperty(globalThis, key);
  });
  return { plugin, dir, ...state };
}

function configFor(plugins: Array<ReturnType<typeof writePlugin>>): OpenClawConfig {
  return {
    plugins: {
      allow: plugins.map((plugin) => plugin.id),
      load: { paths: plugins.map((plugin) => plugin.file) },
      slots: { memory: "none" },
    },
  };
}

async function withEnvironment(dir: string, run: () => Promise<void>) {
  await withEnvAsync(
    {
      OPENCLAW_HOME: dir,
      OPENCLAW_STATE_DIR: dir,
      OPENCLAW_CONFIG_PATH: path.join(dir, "config.json"),
    },
    async () => {
      useNoBundledPlugins();
      try {
        await run();
      } finally {
        await drainOperations();
      }
    },
  );
}

function settle<T>(operation: Promise<T>) {
  const outcome = operation.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  pending.push(outcome);
  return outcome;
}

async function waitForProviderStart(started: Promise<void>, operation: Promise<unknown>) {
  await Promise.race([
    started,
    operation.then(() => {
      throw new Error("Video operation settled before invoking the native provider");
    }),
  ]);
}

afterEach(async () => {
  await drainOperations();
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  unblocks.length = 0;
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it.each([
  ["cold buffer", "buffer", "cold", "none"],
  ["cold URL", "url", "cold", "none"],
  ["cold rejection", "reject", "cold", "none"],
  ["managed host", "buffer", "managed", "none"],
  ["raw host", "buffer", "raw", "none"],
  ["override selection", "buffer", "cold", "override"],
  ["fallback selection", "buffer", "cold", "fallback"],
] as const)(
  "retains and releases video resources for %s",
  async (_name, mode, owner, selection) => {
    let deliveryUrl: string | undefined;
    if (mode === "url") {
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "video/mp4" });
        response.end(videoBytes);
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      cleanups.push(async () => {
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected fixture TCP address");
      }
      deliveryUrl = `http://127.0.0.1:${address.port}/generated.mp4`;
    }
    const first =
      selection === "none" ? undefined : createNativeVideoFixture("first-video-owner", "reject");
    const fixture = createNativeVideoFixture(
      first ? "second-video-owner" : "native-video-owner",
      mode,
      owner === "managed",
      deliveryUrl,
    );
    first?.resume.resolve();
    const cfg = configFor(first ? [first.plugin, fixture.plugin] : [fixture.plugin]);
    if (first) {
      const video = {
        primary: "first-video-owner/fixture-model",
        fallbacks: ["second-video-owner-alias/fixture-model"],
      };
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
    await withEnvironment(fixture.dir, async () => {
      const inspection =
        owner === "managed" ? await acquirePluginRegistryForInspection({ config: cfg }) : undefined;
      cleanups.push(async () => {
        await inspection?.release();
      });
      const registry =
        inspection?.registry ??
        (owner === "raw" ? loadPluginRegistryHandle({ config: cfg }) : undefined);
      const run = () => generateVideo(params);
      const outcome = settle(registry ? withPluginRuntimeRegistryScope(registry, run) : run());
      await waitForProviderStart(
        owner === "managed" ? fixture.lookupStarted.promise : fixture.started.promise,
        outcome,
      );
      expect(fixture.connections).toHaveLength(1);
      const connection = fixture.connections[0]!;
      expect(connection).toMatchObject({ database: { isOpen: true }, disposals: 0 });
      await inspection?.release();
      expect(connection.database.isOpen).toBe(true);
      fixture.lookupResume.resolve();
      await waitForProviderStart(fixture.started.promise, outcome);
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
          expect(result.value?.videos[0]).toMatchObject({ url: deliveryUrl, buffer: undefined });
        } else {
          expect(result.value?.videos[0]?.buffer).toEqual(videoBytes);
        }
        expect(result.value?.metadata).toEqual({ nativeValue: 42 });
        if (first) {
          expect(result.value?.provider).toBe("second-video-owner-alias");
          expect(result.value?.attempts).toHaveLength(selection === "override" ? 0 : 1);
        }
      }
      expect(connection.requests[0]).toMatchObject({
        provider: first ? "second-video-owner-alias" : "native-video-owner-alias",
        timeoutMs: 12_345,
        providerOptions: { seed: 42 },
      });
      expect(connection).toMatchObject({
        database: { isOpen: owner === "raw" },
        disposals: owner === "raw" ? 0 : 1,
      });
      if (first) {
        expect(first.connections[0]).toMatchObject({ database: { isOpen: false }, disposals: 1 });
      }
      if (mode === "url") {
        const response = await fetch(deliveryUrl!);
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(videoBytes);
      }
    });
  },
);
