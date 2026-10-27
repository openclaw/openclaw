import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, expect, it } from "vitest";
import { acquirePluginRegistryForInspection, loadPluginRegistryHandle } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { cleanupNativeFixture, nativeFixtureEnv } from "../plugins/native-resource.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { generateImage, type GenerateImageParams } from "./runtime.js";
import type { ImageGenerationRequest } from "./types.js";

const png = Buffer.from("synthetic-image");
const cleanups: Array<() => Promise<void>> = [];

function createNativeImageFixture(id = "native-image-owner", rejectGeneration = false) {
  useNoBundledPlugins();
  const dir = makePluginLoaderTempDir();
  const key = `__openclaw_image_resources_${path.basename(dir)}`;
  const started = createDeferredCore();
  const resume = createDeferredCore();
  let pending: ReturnType<typeof settle> | undefined;
  const connections: Array<{
    database: DatabaseSync;
    disposals: number;
    reads: number[];
    requests: ImageGenerationRequest[];
  }> = [];
  Reflect.set(globalThis, key, { connections, started, resume, png });
  const plugin = writePlugin({
    dir,
    id,
    registration: `const { DatabaseSync } = require("node:sqlite");
    const state = globalThis[${JSON.stringify(key)}];
    const database = new DatabaseSync(":memory:");
    const connection = { database, disposals: 0, reads: [], requests: [] };
    state.connections.push(connection);
    const read = () => {
      const value = database.prepare("SELECT 42 AS value").get().value;
      connection.reads.push(value);
      return value;
    };
    api.lifecycle.registerRuntimeLifecycle({
      id: "native-image-resource",
      dispose() {
        read();
        connection.disposals++;
        database.close();
      },
    });
    api.registerImageGenerationProvider({
      id: ${JSON.stringify(id)},
      aliases: [${JSON.stringify(`${id}-alias`)}],
      defaultModel: "fixture-model",
      capabilities: { generate: {}, edit: { enabled: true, maxInputImages: 1 } },
      async generateImage(request) {
        connection.requests.push(request);
        read();
        state.started.resolve();
        await state.resume.promise;
        read();
        if (${rejectGeneration}) throw new Error("native image generation failed");
        return {
          images: [{ buffer: state.png, mimeType: "image/png", fileName: "native.png" }],
          metadata: { get nativeValue() { return read(); } },
        };
      },
    });
`,
  });
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      contracts: { imageGenerationProviders: [id] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  const config = {
    plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
  };
  const params: GenerateImageParams = {
    cfg: config,
    prompt: "synthetic native image resource proof",
    modelOverride: `${id}-alias/fixture-model`,
    autoProviderFallback: false,
    inputImages: [{ buffer: png, mimeType: "image/png" }],
    timeoutMs: 12_345,
    providerOptions: { fixture: "kept" },
    ssrfPolicy: { allowRfc2544BenchmarkRange: true },
  };
  cleanups.push(async () => {
    resume.resolve();
    await pending;
    cleanupNativeFixture(key, connections);
  });
  return {
    plugin,
    connections,
    resume,
    config,
    params,
    async start(operation = generateImage(params)) {
      pending = settle(operation);
      await Promise.race([
        started.promise,
        pending.then(() => {
          throw new Error("Image operation settled before invoking the native provider");
        }),
      ]);
      expect(connections).toHaveLength(1);
      return connections[0]!;
    },
    async finish() {
      resume.resolve();
      return await pending!;
    },
    env: nativeFixtureEnv(dir),
  };
}

function settle(operation: ReturnType<typeof generateImage>) {
  return operation.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it.each(["cold", "managed", "raw", "fallback"] as const)(
  "settles %s registration resources",
  async (owner) => {
    const first =
      owner === "fallback" ? createNativeImageFixture("first-image-owner", true) : undefined;
    const fixture = createNativeImageFixture(
      owner === "fallback" ? "second-image-owner" : "native-image-owner",
      owner === "cold",
    );
    first?.resume.resolve();
    await withEnvAsync(fixture.env, async () => {
      const image = first
        ? {
            primary: "first-image-owner/fixture-model",
            fallbacks: ["second-image-owner-alias/fixture-model"],
          }
        : undefined;
      const cfg = { ...fixture.config, agents: { defaults: { mediaModels: { image } } } };
      if (first) {
        cfg.plugins.allow.unshift(first.plugin.id);
        cfg.plugins.load.paths.unshift(first.plugin.file);
      }
      const inspection =
        owner === "managed" ? await acquirePluginRegistryForInspection({ config: cfg }) : undefined;
      const run = () =>
        generateImage({
          ...fixture.params,
          cfg,
          modelOverride: first ? undefined : fixture.params.modelOverride,
        });
      try {
        const operation =
          owner === "managed" || owner === "raw"
            ? withPluginRuntimeRegistryScope(
                inspection?.registry ?? loadPluginRegistryHandle({ config: cfg }),
                run,
              )
            : run();
        const connection = await fixture.start(operation);
        await inspection?.release();
        expect(connection.database.isOpen).toBe(true);
        expect(connection.disposals).toBe(0);
        if (first) {
          expect(first.connections).toHaveLength(1);
          expect(first.connections[0]!.requests).toHaveLength(1);
          expect(first.connections[0]!.database.isOpen).toBe(true);
        }
        const result = await fixture.finish();
        if (owner === "cold") {
          expect(String(result.error)).toContain("native image generation failed");
          expect(connection.requests[0]).toMatchObject({
            provider: "native-image-owner-alias",
            timeoutMs: 12_345,
            inputImages: fixture.params.inputImages,
            providerOptions: fixture.params.providerOptions,
            ssrfPolicy: fixture.params.ssrfPolicy,
          });
          expect(connection.reads).toEqual([42, 42, 42]);
        } else {
          expect(result.error).toBeUndefined();
          expect(result.value?.images[0]?.buffer).toEqual(png);
          expect(result.value?.metadata).toEqual({ nativeValue: 42 });
          if (first) {
            expect(result.value?.provider).toBe("second-image-owner-alias");
            expect(result.value?.attempts).toHaveLength(1);
          }
        }
        for (const resource of [...(first?.connections ?? []), connection]) {
          expect(resource.database.isOpen).toBe(owner === "raw");
          expect(resource.disposals).toBe(owner === "raw" ? 0 : 1);
        }
      } finally {
        await fixture.finish();
        await inspection?.release();
      }
    });
  },
);
