import fs from "node:fs";
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
import { generateImage, type GenerateImageParams } from "./runtime.js";
import type { ImageGenerationRequest } from "./types.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQVDL+DwACFAFmBODefwAAAABJRU5ErkJggg==",
  "base64",
);

function createNativeImageFixture(id = "native-image-owner", rejectGeneration = false) {
  const dir = makePluginLoaderTempDir();
  const key = `__openclaw_image_resources_${path.basename(dir)}`;
  const started = createDeferredCore();
  const resume = createDeferredCore();
  const connections: Array<{
    database: DatabaseSync;
    disposals: number;
    reads: number[];
    requests: ImageGenerationRequest[];
  }> = [];
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: { connections, started, resume, png },
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
  },
};`,
  });
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      contracts: { imageGenerationProviders: [id] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  const config: OpenClawConfig = {
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
  return {
    plugin,
    connections,
    started,
    resume,
    config,
    params,
    run: () => generateImage(params),
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
      throw new Error("Image operation settled before invoking the native provider");
    }),
  ]);
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe("image generation registration resources", () => {
  it.each([false, true])(
    "releases cold image resources after settlement (reject=%s)",
    async (reject) => {
      const fixture = createNativeImageFixture("native-image-owner", reject);
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
            if (reject) {
              expect(String(result.error)).toContain("native image generation failed");
            } else {
              expect(result.error).toBeUndefined();
              expect(result.value?.images[0]?.buffer).toEqual(png);
              expect(result.value?.metadata).toEqual({ nativeValue: 42 });
            }
            expect(connection.requests[0]).toMatchObject({
              provider: "native-image-owner-alias",
              timeoutMs: 12_345,
              inputImages: fixture.params.inputImages,
              providerOptions: fixture.params.providerOptions,
              ssrfPolicy: fixture.params.ssrfPolicy,
            });
            expect(connection.database.isOpen).toBe(false);
            expect(connection.disposals).toBe(1);
            expect(connection.reads).toEqual(reject ? [42, 42, 42] : [42, 42, 42, 42]);
          } finally {
            fixture.resume.resolve();
            await outcome;
          }
        });
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each(["managed", "raw"] as const)(
    "preserves the %s host owner through image generation",
    async (owner) => {
      const fixture = createNativeImageFixture();
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
            await waitForProviderStart(fixture.started.promise, outcome);
            expect(fixture.connections).toHaveLength(1);
            await inspection?.release();
            expect(fixture.connections[0]!.database.isOpen).toBe(true);
            fixture.resume.resolve();
            const result = await outcome;
            expect(result.error).toBeUndefined();
            expect(result.value?.images[0]?.buffer).toEqual(png);
            expect(result.value?.metadata).toEqual({ nativeValue: 42 });
            expect(fixture.connections[0]!.database.isOpen).toBe(owner === "raw");
            expect(fixture.connections[0]!.disposals).toBe(owner === "raw" ? 0 : 1);
          } finally {
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
      const first = createNativeImageFixture("first-image-owner", true);
      const second = createNativeImageFixture("second-image-owner");
      first.resume.resolve();
      try {
        await second.withEnvironment(async () => {
          useNoBundledPlugins();
          const outcome = settle(
            generateImage({
              ...second.params,
              cfg: {
                agents: {
                  defaults: {
                    mediaModels: {
                      image: {
                        primary: "first-image-owner/fixture-model",
                        fallbacks: ["second-image-owner-alias/fixture-model"],
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
            expect(result.value?.provider).toBe("second-image-owner-alias");
            expect(result.value?.images[0]?.buffer).toEqual(png);
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
