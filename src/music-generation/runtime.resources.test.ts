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

function nativeFixture(rejectGeneration = false, id = "native-music-owner") {
  const dir = makePluginLoaderTempDir();
  vi.stubEnv("OPENCLAW_HOME", dir);
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(dir, "config.json"));
  useNoBundledPlugins();
  const alias = id === "native-music-owner" ? "native-music-alias" : `${id}-alias`;
  const key = `__openclaw_music_resources_${path.basename(dir)}`;
  const started = deferred();
  const resume = deferred();
  const connections: Array<{ database: DatabaseSync; disposals: number; calls: number }> = [];
  Reflect.set(globalThis, key, { connections, started, resume, captureAsyncWorkTracker });
  cleanups.push(() => cleanupNativeFixture(key, connections));
  const plugin = writePlugin({
    dir,
    id,
    registration: `const { DatabaseSync } = require("node:sqlite");
    const state = globalThis[${JSON.stringify(key)}];
    const database = new DatabaseSync(":memory:");
    const connection = { database, disposals: 0, calls: 0 };
    state.connections.push(connection);
    const read = () => database.prepare("SELECT 42 AS value").get();
    let trackCleanup = state.captureAsyncWorkTracker();
    const disposeNative = async () => {
      await Promise.resolve();
      read();
      connection.disposals++;
      database.close();
    };
    api.registerRuntimeLifecycle({
      id: "native-music-resource",
      dispose: () => trackCleanup(disposeNative),
    });
    api.registerMusicGenerationProvider({
      id: ${JSON.stringify(id)},
      aliases: [${JSON.stringify(alias)}],
      defaultModel: "fixture-model",
      capabilities: {},
      async generateMusic() {
        connection.calls++;
        trackCleanup = state.captureAsyncWorkTracker();
        read();
        state.started.resolve();
        await state.resume.promise;
        read();
        if (${rejectGeneration}) throw new Error("native music generation failed");
        return { tracks: [{ buffer: Buffer.from("native music 42"), mimeType: "audio/mpeg" }] };
      },
    });`,
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
  const run = (params: Partial<GenerateMusicParams> = {}) =>
    generateMusic({
      cfg: config,
      prompt: "synthetic native resource proof",
      modelOverride: `${alias}/fixture-model`,
      autoProviderFallback: false,
      ...params,
    });
  return { config, plugin, connections, started, resume, run };
}

type NativeFixture = ReturnType<typeof nativeFixture>;

async function inspect(fixture: NativeFixture) {
  const inspection = await acquirePluginRegistryForInspection({ config: fixture.config });
  releases.push(inspection.release);
  return inspection;
}

async function start<T>(operation: Promise<T>, started: Promise<void>) {
  const settled = operation.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  pending.push(settled);
  await Promise.race([
    started,
    settled.then((cause) => {
      throw new Error("Music operation settled before invoking the native provider", { cause });
    }),
  ]);
  return { settled };
}

function expectConnection(fixture: NativeFixture, open: boolean) {
  expect(fixture.connections).toHaveLength(1);
  const { database, disposals } = fixture.connections[0]!;
  expect({ open: database.isOpen, disposals }).toEqual({ open, disposals: open ? 0 : 1 });
}

function expectMusic(outcome: { value?: GenerateMusicRuntimeResult; error?: unknown }) {
  expect(outcome.value?.provider).toBe("native-music-alias");
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

it.each([false, true])(
  "joins getter work before release (projection failure: %s)",
  async (fails) => {
    const fixture = nativeFixture();
    const readGate = deferred();
    const entered = deferred();
    const projectionError = new Error("native music projection failed");
    let projectionWork: Promise<void> | undefined;
    let parentRelease: Promise<void> | undefined;
    let read: unknown;
    const inspection = await inspect(fixture);
    const provider = inspection.registry.musicGenerationProviders[0]!.provider;
    const id = provider.id;
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
        if (fails) {
          throw projectionError;
        }
        return id;
      },
    });
    const { settled } = await start(
      withPluginRuntimeRegistryScope(inspection.registry, fixture.run),
      fails ? entered.promise : fixture.started.promise,
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expectConnection(fixture, true);
    if (!fails) {
      await parentRelease;
    }
    readGate.resolve();
    fixture.resume.resolve();
    const outcome = await settled;
    if (fails) {
      expect(outcome.error).toBe(projectionError);
    } else {
      expectMusic(outcome);
    }
    expect(read).toEqual({ value: 42 });
    expectConnection(fixture, false);
  },
);

it.each(["override", "reject", "managed", "raw"] as const)(
  "retains %s resources until the owning lifetime ends",
  async (ownership) => {
    const cold = ownership === "override" || ownership === "reject";
    const configured = ownership === "override" ? nativeFixture(false, "configured") : undefined;
    configured?.resume.resolve();
    const fixture = nativeFixture(ownership === "reject");
    retireRaw = ownership === "raw";
    const inspection = cold || retireRaw ? undefined : await inspect(fixture);
    const registry = cold
      ? undefined
      : (inspection?.registry ?? loadPluginRegistryHandle({ config: fixture.config }));
    const run = () =>
      fixture.run(
        configured
          ? {
              cfg: {
                ...pluginConfig(configured.plugin, fixture.plugin),
                agents: {
                  defaults: { mediaModels: { music: { primary: "configured/fixture-model" } } },
                },
              },
              autoProviderFallback: true,
            }
          : {},
      );
    const { settled } = await start(
      registry ? withPluginRuntimeRegistryScope(registry, run) : run(),
      fixture.started.promise,
    );
    if (configured) {
      expect(configured.connections.map(({ calls }) => calls)).toEqual([0]);
    }
    await inspection?.release();
    expectConnection(fixture, true);
    fixture.resume.resolve();
    const outcome = await settled;
    if (ownership === "reject") {
      expect(String(outcome.error)).toContain("native music generation failed");
    } else {
      expectMusic(outcome);
    }
    expectConnection(fixture, retireRaw);
    if (configured) {
      expectConnection(configured, false);
    }
  },
);
