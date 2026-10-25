import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { acquirePluginRegistryForInspection, loadPluginRegistryHandle } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { cleanupNativeFixture } from "../plugins/native-resource.test-support.js";
import { waitForPluginCacheRetirement } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { captureAsyncWorkTracker, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { GenerateMusicParams, GenerateMusicRuntimeResult } from "./runtime-types.js";
import { generateMusic } from "./runtime.js";

const unblocks: Array<() => void> = [];
const pending: Promise<unknown>[] = [];
const releases: Array<() => Promise<void>> = [];
const cleanups: Array<() => void> = [];
let retireRaw = false;

function deferred() {
  const gate = createDeferredCore();
  unblocks.push(() => gate.resolve());
  return gate;
}

function pluginConfig(...plugins: Array<{ id: string; file: string }>): OpenClawConfig {
  return {
    plugins: {
      allow: plugins.map((plugin) => plugin.id),
      load: { paths: plugins.map((plugin) => plugin.file) },
      slots: { memory: "none" },
    },
  };
}

function nativeFixture(
  rejectGeneration = false,
  id = "native-music-owner",
  disposalContext: "operation" | "registration" | "node-bound" = "operation",
) {
  const dir = makePluginLoaderTempDir();
  vi.stubEnv("OPENCLAW_HOME", dir);
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(dir, "config.json"));
  useNoBundledPlugins();
  const alias = id === "native-music-owner" ? "native-music-alias" : `${id}-alias`;
  const key = `__openclaw_music_resources_${path.basename(dir)}`;
  const started = deferred();
  const resume = deferred();
  const connections: Array<{ database: DatabaseSync; disposals: number; reads: number[] }> = [];
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: { connections, started, resume, captureAsyncWorkTracker },
  });
  cleanups.push(() => {
    cleanupNativeFixture(key, connections);
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
  const config = pluginConfig(plugin);
  return {
    config,
    plugin,
    connections,
    started,
    resume,
    run: (params: Partial<GenerateMusicParams> = {}) =>
      generateMusic({
        cfg: config,
        prompt: "synthetic native resource proof",
        modelOverride: `${alias}/fixture-model`,
        autoProviderFallback: false,
        ...params,
      }),
  };
}

type NativeFixture = ReturnType<typeof nativeFixture>;

async function inspect(fixture: NativeFixture) {
  const inspection = await acquirePluginRegistryForInspection({ config: fixture.config });
  releases.push(inspection.release);
  return inspection;
}

function settle<T>(operation: Promise<T>) {
  const settled = operation.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  pending.push(settled);
  return settled;
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

async function waitForProviderStart(started: Promise<void>, operation: Promise<unknown>) {
  await Promise.race([
    started,
    operation.then((outcome) => {
      throw new Error("Music operation settled before invoking the native provider", {
        cause: outcome,
      });
    }),
  ]);
}

afterEach(async () => {
  try {
    // Drain admitted work before releasing the inspections or closing native resources.
    unblocks.forEach((unblock) => unblock());
    await Promise.allSettled(pending);
    await Promise.all(releases.map((release) => release()));
    if (retireRaw) {
      clearPluginMetadataLifecycleCaches();
      expect((await waitForPluginCacheRetirement()).failures).toEqual([]);
    }
  } finally {
    vi.unstubAllEnvs();
    cleanups.forEach((cleanup) => cleanup());
    unblocks.length = pending.length = releases.length = cleanups.length = 0;
    retireRaw = false;
    clearPluginMetadataLifecycleCaches();
    resetPluginLoaderTestStateForTest();
  }
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("selects an override alias from a different eligible plugin than the configured model", async () => {
  const configured = nativeFixture(false, "configured-music-owner");
  const override = nativeFixture();
  configured.resume.resolve();
  const settled = settle(
    override.run({
      cfg: {
        ...pluginConfig(configured.plugin, override.plugin),
        agents: {
          defaults: { mediaModels: { music: { primary: "configured-music-owner/fixture-model" } } },
        },
      },
      autoProviderFallback: true,
    }),
  );
  await waitForProviderStart(override.started.promise, settled);
  expect(configured.connections).toHaveLength(1);
  expect(configured.connections[0]!.reads).toEqual([]);
  expectConnection(override, true);
  override.resume.resolve();
  expectMusic(await settled);
  expectConnection(configured, false);
  expectConnection(override, false);
});

it("joins admitted getter work before releasing the last claim on projection failure", async () => {
  const fixture = nativeFixture();
  const readGate = deferred();
  const entered = deferred();
  const projectionError = new Error("native music projection failed");
  let projectionWork: Promise<void> | undefined;
  let parentRelease: Promise<void> | undefined;
  let read: unknown;
  const inspection = await inspect(fixture);
  const provider = inspection.registry.musicGenerationProviders[0]!.provider;
  Object.defineProperty(provider, "id", {
    get() {
      projectionWork ??= trackAsyncWork(async () => {
        await readGate.promise;
        read = fixture.connections[0]!.database.prepare("SELECT 42 AS value").get();
      });
      void projectionWork.catch(() => undefined);
      parentRelease ??= inspection.release();
      pending.push(projectionWork, parentRelease);
      entered.resolve();
      throw projectionError;
    },
  });
  const settled = settle(withPluginRuntimeRegistryScope(inspection.registry, fixture.run));
  await waitForProviderStart(entered.promise, settled);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expectConnection(fixture, true);
  readGate.resolve();
  expect((await settled).error).toBe(projectionError);
  await projectionWork;
  expect(read).toEqual({ value: 42 });
  expectConnection(fixture, false);
});

it.each(["cold", "reject", "registration", "node-bound", "managed", "getter", "raw"] as const)(
  "retains %s resources until the owning lifetime ends",
  async (ownership) => {
    const delayedRelease = ownership === "registration" || ownership === "node-bound";
    const cold = ownership === "cold" || ownership === "reject";
    const fixture = nativeFixture(
      ownership === "reject",
      "native-music-owner",
      delayedRelease ? ownership : "operation",
    );
    retireRaw = ownership === "raw";
    const inspection = cold || retireRaw ? undefined : await inspect(fixture);
    const registry = cold
      ? undefined
      : (inspection?.registry ?? loadPluginRegistryHandle({ config: fixture.config }));
    let projectionRelease: Promise<void> | undefined;
    if (ownership === "getter") {
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
    if (delayedRelease) {
      fixture.resume.resolve();
    }
    const settled = settle(
      registry ? withPluginRuntimeRegistryScope(registry, fixture.run) : fixture.run(),
    );
    await waitForProviderStart(fixture.started.promise, settled);
    expect(fixture.connections).toHaveLength(1);
    if (!delayedRelease) {
      if (ownership === "getter") {
        expect(projectionRelease).toBeDefined();
        await projectionRelease;
      }
      await inspection?.release();
      expectConnection(fixture, true, cold ? undefined : [42]);
    }
    fixture.resume.resolve();
    const outcome = await settled;
    if (ownership === "reject") {
      expect(outcome.error).toBeInstanceOf(Error);
      expect(String(outcome.error)).toContain("native music generation failed");
    } else {
      expectMusic(outcome);
    }
    if (delayedRelease) {
      expectConnection(fixture, true);
      await inspection?.release();
    }
    expectConnection(fixture, retireRaw, retireRaw ? [42, 42] : [42, 42, 42]);
  },
);
