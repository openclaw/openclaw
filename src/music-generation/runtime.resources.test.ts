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
import { waitForPluginCacheRetirement } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { captureAsyncWorkTracker, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { GenerateMusicRuntimeResult } from "./runtime-types.js";
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

type NativeFixture = ReturnType<typeof createNativeMusicFixture>;

async function withFixture(fixture: NativeFixture, operation: () => Promise<void>) {
  try {
    await fixture.withEnvironment(async () => {
      useNoBundledPlugins();
      await operation();
    });
  } finally {
    fixture.cleanup();
  }
}

function settle<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
}

function expectConnection(fixture: NativeFixture, open: boolean, reads?: number[]) {
  expect(fixture.connections).toHaveLength(1);
  const { database, disposals, reads: actualReads } = fixture.connections[0]!;
  expect({ open: database.isOpen, disposals }).toEqual({ open, disposals: open ? 0 : 1 });
  if (reads) {
    expect(actualReads).toEqual(reads);
  }
}

function expectMusic(outcome: { value?: GenerateMusicRuntimeResult; error?: unknown }) {
  expect(outcome.error).toBeUndefined();
  expect(outcome.value?.tracks[0]?.buffer.toString()).toBe("native music 42");
  expect(outcome.value?.provider).toBe("native-music-alias");
}

async function waitForProviderStart(
  started: Promise<void>,
  operation: Promise<unknown>,
): Promise<void> {
  await Promise.race([
    started,
    operation.then((outcome) => {
      throw new Error("Music operation settled before invoking the native provider", {
        cause: outcome,
      });
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
      await withFixture(fixture, async () => {
        const settled = settle(fixture.run());
        try {
          await waitForProviderStart(fixture.started.promise, settled);
          expectConnection(fixture, true);
          fixture.resume.resolve();
          const outcome = await settled;
          if (rejectGeneration) {
            expect(outcome.error).toBeInstanceOf(Error);
            expect(String(outcome.error)).toContain("native music generation failed");
          } else {
            expectMusic(outcome);
          }
          expectConnection(fixture, false, [42, 42, 42]);
        } finally {
          fixture.resume.resolve();
          await settled;
        }
      });
    },
  );

  it("selects an override alias from a different eligible plugin than the configured model", async () => {
    const configured = createNativeMusicFixture(false, "configured-music-owner");
    const override = createNativeMusicFixture();
    configured.resume.resolve();
    try {
      await withFixture(override, async () => {
        const settled = settle(
          generateMusic({
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
          }),
        );
        try {
          await waitForProviderStart(override.started.promise, settled);
          expect(configured.connections).toHaveLength(1);
          expect(override.connections).toHaveLength(1);
          expect(configured.connections[0]!.reads).toEqual([]);
          expect(override.connections[0]!.database.isOpen).toBe(true);
          override.resume.resolve();
          const outcome = await settled;
          expectMusic(outcome);
          expectConnection(configured, false);
          expectConnection(override, false);
        } finally {
          override.resume.resolve();
          await settled;
        }
      });
    } finally {
      configured.cleanup();
    }
  });

  it.each(["registration", "node-bound"] as const)(
    "supports later managed-host disposal with %s cleanup context",
    async (disposalContext) => {
      const fixture = createNativeMusicFixture(false, "native-music-owner", disposalContext);
      await withFixture(fixture, async () => {
        const inspection = await acquirePluginRegistryForInspection({ config: fixture.config });
        try {
          fixture.resume.resolve();
          const result = await withPluginRuntimeRegistryScope(inspection.registry, fixture.run);
          expect(result.tracks[0]?.buffer.toString()).toBe("native music 42");
          expectConnection(fixture, true);
          await inspection.release();
          expectConnection(fixture, false, [42, 42, 42]);
        } finally {
          fixture.resume.resolve();
          await inspection.release();
        }
      });
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
    await withFixture(fixture, async () => {
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
      const settled = settle(withPluginRuntimeRegistryScope(inspection.registry, fixture.run));
      try {
        await waitForProviderStart(entered.promise, settled);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expectConnection(fixture, true);
        readGate.resolve();
        const outcome = await settled;
        expect(outcome.error).toBe(projectionError);
        await projectionWork;
        expect(read).toEqual({ value: 42 });
        expectConnection(fixture, false);
      } finally {
        readGate.resolve();
        fixture.resume.resolve();
        await Promise.allSettled([settled, projectionWork, parentRelease]);
        await inspection.release();
      }
    });
  });

  it.each(["managed", "managed-getter", "raw"] as const)(
    "keeps %s registration resources until the operation settles",
    async (ownership) => {
      const fixture = createNativeMusicFixture();
      await withFixture(fixture, async () => {
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
        const settled = settle(withPluginRuntimeRegistryScope(registry, fixture.run));
        try {
          await waitForProviderStart(fixture.started.promise, settled);
          expect(fixture.connections).toHaveLength(1);
          if (ownership === "managed-getter") {
            expect(projectionRelease).toBeDefined();
            await projectionRelease;
          }
          await inspection?.release();
          expectConnection(fixture, true, [42]);
          fixture.resume.resolve();
          const outcome = await settled;
          expectMusic(outcome);
          expectConnection(
            fixture,
            ownership === "raw",
            ownership === "raw" ? [42, 42] : [42, 42, 42],
          );
        } finally {
          fixture.resume.resolve();
          await settled;
          await inspection?.release();
          if (ownership === "raw") {
            clearPluginMetadataLifecycleCaches();
            const cleanup = await waitForPluginCacheRetirement();
            expect(cleanup.failures).toEqual([]);
          }
        }
      });
    },
  );
});
