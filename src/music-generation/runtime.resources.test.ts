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
import { captureAsyncWorkTracker, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { generateMusic } from "./runtime.js";

function createNativeMusicFixture(
  rejectGeneration = false,
  id = "native-music-owner",
  disposalContext: "operation" | "registration" | "node-bound" = "operation",
) {
  const dir = makePluginLoaderTempDir();
  const alias = id === "native-music-owner" ? "native-music-alias" : `${id}-alias`;
  const key = `__openclaw_music_resources_${path.basename(dir)}`;
  const started = createDeferredCore();
  const resume = createDeferredCore();
  const connections: Array<{
    database: DatabaseSync;
    disposals: number;
    reads: number[];
  }> = [];
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: { connections, started, resume, captureAsyncWorkTracker },
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
    const connection = { database, disposals: 0, reads: [] };
    state.connections.push(connection);
    let trackCleanup = state.captureAsyncWorkTracker();
    const disposeNative = async () => {
      await Promise.resolve();
      connection.reads.push(database.prepare("SELECT 42 AS value").get().value);
      connection.disposals++;
      database.close();
    };
    let runDispose = () => trackCleanup(disposeNative);
    api.registerRuntimeLifecycle({
      id: "native-music-resource",
      dispose: () => runDispose(),
    });
    api.registerMusicGenerationProvider({
      id: ${JSON.stringify(id)},
      aliases: [${JSON.stringify(alias)}],
      label: "Native music fixture",
      defaultModel: "fixture-model",
      capabilities: {},
      async generateMusic() {
        if (${JSON.stringify(disposalContext)} === "operation") {
          trackCleanup = state.captureAsyncWorkTracker();
        } else if (${JSON.stringify(disposalContext)} === "node-bound") {
          runDispose = require("node:async_hooks").AsyncLocalStorage.bind(disposeNative);
        }
        connection.reads.push(database.prepare("SELECT 42 AS value").get().value);
        state.started.resolve();
        await state.resume.promise;
        connection.reads.push(database.prepare("SELECT 42 AS value").get().value);
        if (${rejectGeneration}) throw new Error("native music generation failed");
        return { tracks: [{ buffer: Buffer.from("native music 42"), mimeType: "audio/mpeg" }] };
      },
    });
  },
};`,
  });
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      contracts: { musicGenerationProviders: [id] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  const config: OpenClawConfig = {
    plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
  };
  const run = () =>
    generateMusic({
      cfg: config,
      prompt: "synthetic native resource proof",
      modelOverride: `${alias}/fixture-model`,
      autoProviderFallback: false,
    });
  return {
    config,
    plugin,
    connections,
    started,
    resume,
    run,
    withEnvironment: (operation: () => Promise<void>) =>
      withEnvAsync(
        {
          OPENCLAW_HOME: dir,
          OPENCLAW_STATE_DIR: dir,
          OPENCLAW_CONFIG_PATH: path.join(dir, "config.json"),
        },
        operation,
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

async function waitForProviderStart(
  started: Promise<void>,
  operation: Promise<unknown>,
): Promise<void> {
  await Promise.race([
    started,
    operation.then(() => {
      throw new Error("Music operation settled before invoking the native provider");
    }),
  ]);
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe("music generation registration resources", () => {
  it.each([false, true])(
    "releases a cold native registration after generation settles (reject=%s)",
    async (rejectGeneration) => {
      const fixture = createNativeMusicFixture(rejectGeneration);
      try {
        await fixture.withEnvironment(async () => {
          useNoBundledPlugins();
          const result = fixture.run();
          const settled = result.then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: undefined, error }),
          );
          try {
            await waitForProviderStart(fixture.started.promise, settled);
            expect(fixture.connections).toHaveLength(1);
            expect(fixture.connections[0]!.database.isOpen).toBe(true);
            expect(fixture.connections[0]!.disposals).toBe(0);
            fixture.resume.resolve();
            const outcome = await settled;
            if (rejectGeneration) {
              expect(outcome.error).toBeInstanceOf(Error);
              expect(String(outcome.error)).toContain("native music generation failed");
            } else {
              expect(outcome.error).toBeUndefined();
              expect(outcome.value?.tracks[0]?.buffer.toString()).toBe("native music 42");
              expect(outcome.value?.provider).toBe("native-music-alias");
            }
            expect(fixture.connections[0]!.database.isOpen).toBe(false);
            expect(fixture.connections[0]!.disposals).toBe(1);
            expect(fixture.connections[0]!.reads).toEqual([42, 42, 42]);
          } finally {
            fixture.resume.resolve();
            await settled;
          }
        });
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("selects an override alias from a different eligible plugin than the configured model", async () => {
    const configured = createNativeMusicFixture(false, "configured-music-owner");
    const override = createNativeMusicFixture();
    configured.resume.resolve();
    try {
      await override.withEnvironment(async () => {
        useNoBundledPlugins();
        const result = generateMusic({
          cfg: {
            agents: {
              defaults: {
                mediaModels: { music: { primary: "configured-music-owner/fixture-model" } },
              },
            },
            plugins: {
              allow: [configured.plugin.id, override.plugin.id],
              load: { paths: [configured.plugin.file, override.plugin.file] },
              slots: { memory: "none" },
            },
          },
          prompt: "synthetic override selection proof",
          modelOverride: "native-music-alias/fixture-model",
        });
        const settled = result.then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        try {
          await waitForProviderStart(override.started.promise, settled);
          expect(configured.connections).toHaveLength(1);
          expect(override.connections).toHaveLength(1);
          expect(configured.connections[0]!.reads).toEqual([]);
          expect(override.connections[0]!.database.isOpen).toBe(true);
          override.resume.resolve();
          const outcome = await settled;
          expect(outcome.error).toBeUndefined();
          expect(outcome.value?.provider).toBe("native-music-alias");
          expect(outcome.value?.tracks[0]?.buffer.toString()).toBe("native music 42");
          for (const { database, disposals } of [
            ...configured.connections,
            ...override.connections,
          ]) {
            expect(database.isOpen).toBe(false);
            expect(disposals).toBe(1);
          }
        } finally {
          override.resume.resolve();
          await settled;
        }
      });
    } finally {
      configured.cleanup();
      override.cleanup();
    }
  });

  it.each(["registration", "node-bound"] as const)(
    "supports later managed-host disposal with %s cleanup context",
    async (disposalContext) => {
      const fixture = createNativeMusicFixture(false, "native-music-owner", disposalContext);
      try {
        await fixture.withEnvironment(async () => {
          useNoBundledPlugins();
          const inspection = await acquirePluginRegistryForInspection({ config: fixture.config });
          try {
            fixture.resume.resolve();
            const result = await withPluginRuntimeRegistryScope(inspection.registry, fixture.run);
            expect(result.tracks[0]?.buffer.toString()).toBe("native music 42");
            expect(fixture.connections).toHaveLength(1);
            expect(fixture.connections[0]!.database.isOpen).toBe(true);
            expect(fixture.connections[0]!.disposals).toBe(0);
            await inspection.release();
            expect(fixture.connections[0]!.database.isOpen).toBe(false);
            expect(fixture.connections[0]!.reads).toEqual([42, 42, 42]);
            expect(fixture.connections[0]!.disposals).toBe(1);
          } finally {
            fixture.resume.resolve();
            await inspection.release();
          }
        });
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("joins admitted getter work before releasing the last claim on projection failure", async () => {
    const fixture = createNativeMusicFixture();
    const readGate = createDeferredCore();
    const entered = createDeferredCore();
    const projectionError = new Error("native music projection failed");
    let projectionWork: Promise<void> | undefined;
    let parentRelease: Promise<void> | undefined;
    let read: unknown;
    try {
      await fixture.withEnvironment(async () => {
        useNoBundledPlugins();
        const inspection = await acquirePluginRegistryForInspection({ config: fixture.config });
        const connection = fixture.connections[0]!;
        const provider = inspection.registry.musicGenerationProviders[0]!.provider;
        Object.defineProperty(provider, "id", {
          get() {
            projectionWork ??= trackAsyncWork(async () => {
              await readGate.promise;
              read = connection.database.prepare("SELECT 42 AS value").get();
            });
            void projectionWork.catch(() => undefined);
            parentRelease ??= inspection.release();
            entered.resolve();
            throw projectionError;
          },
        });
        const settled = withPluginRuntimeRegistryScope(inspection.registry, fixture.run).then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        try {
          await waitForProviderStart(entered.promise, settled);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(connection.database.isOpen).toBe(true);
          expect(connection.disposals).toBe(0);
          readGate.resolve();
          const outcome = await settled;
          expect(outcome.error).toBe(projectionError);
          await projectionWork;
          expect(read).toEqual({ value: 42 });
          expect(connection.database.isOpen).toBe(false);
          expect(connection.disposals).toBe(1);
        } finally {
          readGate.resolve();
          fixture.resume.resolve();
          await Promise.allSettled([settled, projectionWork, parentRelease]);
          await inspection.release();
        }
      });
    } finally {
      fixture.cleanup();
    }
  });

  it.each(["managed", "managed-getter", "raw"] as const)(
    "preserves the existing %s registration owner during generation",
    async (ownership) => {
      const fixture = createNativeMusicFixture();
      try {
        await fixture.withEnvironment(async () => {
          useNoBundledPlugins();
          const inspection =
            ownership !== "raw"
              ? await acquirePluginRegistryForInspection({ config: fixture.config })
              : undefined;
          const registry =
            inspection?.registry ?? loadPluginRegistryHandle({ config: fixture.config });
          let projectionRelease: Promise<void> | undefined;
          if (ownership === "managed-getter") {
            expect(inspection).toBeDefined();
            const managed = inspection!;
            const provider = managed.registry.musicGenerationProviders[0]!.provider;
            const id = provider.id;
            Object.defineProperty(provider, "id", {
              get() {
                projectionRelease ??= managed.release();
                return id;
              },
            });
          }
          const result = withPluginRuntimeRegistryScope(registry, fixture.run);
          const settled = result.then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: undefined, error }),
          );
          try {
            await waitForProviderStart(fixture.started.promise, settled);
            expect(fixture.connections).toHaveLength(1);
            if (ownership === "managed-getter") {
              expect(projectionRelease).toBeDefined();
              await projectionRelease;
            }
            await inspection?.release();
            expect(fixture.connections[0]!.database.isOpen).toBe(true);
            fixture.resume.resolve();
            const outcome = await settled;
            expect(outcome.error).toBeUndefined();
            expect(outcome.value?.tracks[0]?.buffer.toString()).toBe("native music 42");
            expect(fixture.connections[0]!.database.isOpen).toBe(ownership === "raw");
            expect(fixture.connections[0]!.disposals).toBe(ownership === "raw" ? 0 : 1);
          } finally {
            fixture.resume.resolve();
            await settled;
            await inspection?.release();
          }
        });
      } finally {
        fixture.cleanup();
      }
    },
  );
});
