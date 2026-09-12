import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
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
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";

function createPreparationFixture() {
  const dir = makePluginLoaderTempDir();
  const id = "native-speech-preparation";
  const key = `__openclaw_speech_preparation_${path.basename(dir)}`;
  const connections: Array<{
    database: DatabaseSync;
    disposals: number;
    cleanups: number;
    opaque: { voiceId: string };
  }> = [];
  const callbacks: {
    onMetadata?: () => void;
    onProjection?: () => void;
    onDispose?: () => Promise<void>;
    trackTail?: boolean;
  } = {};
  const tailResume = createDeferredCore();
  const tails: Promise<void>[] = [];
  const consumedVoices: string[] = [];
  const state = { connections, callbacks, tailResume, tails, consumedVoices, trackAsyncWork, dir };
  Object.defineProperty(globalThis, key, { configurable: true, value: state });
  const plugin = writePlugin({
    dir,
    id,
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  const state = globalThis[${JSON.stringify(key)}];
  const database = new DatabaseSync(require("node:path").join(state.dir, "preparation-" + state.connections.length + ".sqlite"));
  database.exec("CREATE TABLE fixture(value INTEGER); INSERT INTO fixture VALUES(42)");
  const read = () => database.prepare("SELECT value FROM fixture").get().value;
  const connection = { database, disposals: 0, cleanups: 0,
    opaque: { get voiceId() { return "voice-" + read(); } } };
  state.connections.push(connection);
  api.lifecycle.registerRuntimeLifecycle({ id: "speech-preparation-resource",
    async dispose() { await state.callbacks.onDispose?.(); read(); connection.disposals++; database.close(); },
    cleanup() { read(); connection.cleanups++; database.close(); }
  });
  api.registerSpeechProvider({
    get id() { state.callbacks.onMetadata?.(); read(); return ${JSON.stringify(id)}; },
    aliases: [${JSON.stringify(`${id}-alias`)}], label: "Native speech preparation",
    resolveConfig() { read(); return {}; },
    isConfigured() { read(); return true; },
    parseDirectiveToken({ key }) {
      if (key !== "voice") return { handled: false };
      read();
      if (state.callbacks.trackTail) {
        state.tails.push(state.trackAsyncWork(async () => { await state.tailResume.promise; read(); }));
      }
      return { handled: true, get overrides() {
        state.callbacks.onProjection?.(); read(); return { voiceSettings: connection.opaque };
      } };
    },
    async synthesize() { throw new Error("Buffered fixture synthesis is unused"); },
    async synthesizeTelephony(request) {
      read(); state.consumedVoices.push(request.providerOverrides.voiceSettings.voiceId);
      return { audioBuffer: Buffer.from([42, 0]), sampleRate: 8000, outputFormat: "pcm" };
    }
  });
} };`,
  });
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({ id, contracts: { speechProviders: [id] }, configSchema: { type: "object" } }),
  );
  const cfg: OpenClawConfig = {
    plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
    tts: { provider: id, providers: { [id]: {} }, modelOverrides: { allowProvider: true } },
  };
  const host = new LegacyPluginSdkResourceHost();
  const runtime = createPluginRuntime();
  const text = `Hello [[tts:provider=${id}-alias voice=fixture]]`;
  return {
    cfg,
    id,
    host,
    runtime,
    state,
    prepare: () => runtime.tts.prepareTtsRequest({ cfg, text }),
    withEnvironment: (run: () => Promise<void>) =>
      withEnvAsync(
        {
          OPENCLAW_HOME: dir,
          OPENCLAW_STATE_DIR: dir,
          OPENCLAW_CONFIG_PATH: path.join(dir, "config.json"),
          OPENCLAW_TTS_PREFS: path.join(dir, "prefs.json"),
        },
        () => host.run(run),
      ),
    async cleanup() {
      tailResume.resolve();
      await Promise.allSettled(tails);
      await host.close();
      for (const { database } of connections) {
        if (database.isOpen) {
          database.close();
        }
      }
      Reflect.deleteProperty(globalThis, key);
    },
  };
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe("async speech preparation resources", () => {
  it("reuses registrations and preserves opaque overrides for synthesis after inspection retirement", async () => {
    const fixture = createPreparationFixture();
    try {
      await fixture.withEnvironment(async () => {
        useNoBundledPlugins();
        const inspection = await acquirePluginRegistryForInspection({ config: fixture.cfg });
        try {
          const prepared = await withPluginRuntimeRegistryScope(inspection.registry, async () => {
            const first = await fixture.prepare();
            for (let index = 0; index < 3; index++) {
              const next = await fixture.prepare();
              expect(
                next.directives.overrides.providerOverrides?.[fixture.id]?.voiceSettings ===
                  first.directives.overrides.providerOverrides?.[fixture.id]?.voiceSettings,
              ).toBe(true);
            }
            return first;
          });
          expect(fixture.state.connections.length).toBe(1);
          await inspection.release();
          expect(fixture.state.connections[0]?.database.isOpen).toBe(true);
          expect(
            prepared.directives.overrides.providerOverrides?.[fixture.id]?.voiceSettings ===
              fixture.state.connections[0]?.opaque,
          ).toBe(true);
          const result = await fixture.runtime.tts.textToSpeechTelephony({
            cfg: prepared.cfg,
            text: prepared.directives.cleanedText,
            overrides: prepared.directives.overrides,
          });
          expect(result.success).toBe(true);
          expect(fixture.state.consumedVoices).toEqual(["voice-42"]);
          await fixture.host.close();
          expect(fixture.state.connections.every((entry) => !entry.database.isOpen)).toBe(true);
          expect(fixture.state.connections.every((entry) => entry.disposals === 1)).toBe(true);
        } finally {
          await inspection.release();
        }
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("retains the selected source before provider metadata can retire its inspection", async () => {
    const fixture = createPreparationFixture();
    try {
      await fixture.withEnvironment(async () => {
        useNoBundledPlugins();
        const inspection = await acquirePluginRegistryForInspection({ config: fixture.cfg });
        let retirement: Promise<void> | undefined;
        fixture.state.callbacks.onMetadata = () => {
          retirement ??= inspection.release();
        };
        try {
          const prepared = await withPluginRuntimeRegistryScope(
            inspection.registry,
            fixture.prepare,
          );
          await retirement;
          expect(prepared.directives.hasDirective).toBe(true);
          expect(fixture.state.connections[0]?.opaque.voiceId).toBe("voice-42");
          await fixture.host.close();
          expect(fixture.state.connections[0]?.disposals).toBe(1);
        } finally {
          await inspection.release();
        }
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("owns failed projection cleanup until asynchronous disposal finishes", async () => {
    const fixture = createPreparationFixture();
    const disposeResume = createDeferredCore();
    try {
      await fixture.withEnvironment(async () => {
        useNoBundledPlugins();
        const inspection = await acquirePluginRegistryForInspection({ config: fixture.cfg });
        let retirement: Promise<void> | undefined;
        fixture.state.callbacks.onDispose = () => disposeResume.promise;
        fixture.state.callbacks.onProjection = () => {
          retirement ??= inspection.release();
          throw new Error("speech directive projection failed");
        };
        try {
          await expect(
            withPluginRuntimeRegistryScope(inspection.registry, fixture.prepare),
          ).rejects.toThrow("speech directive projection failed");
          let closed = false;
          const closing = fixture.host.close().then(() => {
            closed = true;
          });
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(closed).toBe(false);
          disposeResume.resolve();
          await closing;
          expect(fixture.state.connections[0]?.disposals).toBe(1);
        } finally {
          disposeResume.resolve();
          await retirement;
          await inspection.release();
        }
      });
    } finally {
      disposeResume.resolve();
      await fixture.cleanup();
    }
  });

  it("keeps failed projection resources alive through its tracked directive tail", async () => {
    const fixture = createPreparationFixture();
    try {
      await fixture.withEnvironment(async () => {
        useNoBundledPlugins();
        const inspection = await acquirePluginRegistryForInspection({ config: fixture.cfg });
        let retirement: Promise<void> | undefined;
        fixture.state.callbacks.trackTail = true;
        fixture.state.callbacks.onProjection = () => {
          retirement ??= inspection.release();
          throw new Error("speech directive projection failed");
        };
        try {
          await expect(
            withPluginRuntimeRegistryScope(inspection.registry, fixture.prepare).then(
              () => undefined,
            ),
          ).rejects.toThrow("speech directive projection failed");
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(fixture.state.connections[0]?.database.isOpen).toBe(true);
          let closed = false;
          const closing = fixture.host.close().then(() => {
            closed = true;
          });
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(closed).toBe(false);
          fixture.state.tailResume.resolve();
          await Promise.all(fixture.state.tails);
          await closing;
          expect(fixture.state.connections[0]?.disposals).toBe(1);
        } finally {
          fixture.state.tailResume.resolve();
          await Promise.allSettled(fixture.state.tails);
          await retirement;
          await inspection.release();
        }
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects projection when its SDK host closes during preparation", async () => {
    const fixture = createPreparationFixture();
    try {
      await fixture.withEnvironment(async () => {
        useNoBundledPlugins();
        const inspection = await acquirePluginRegistryForInspection({ config: fixture.cfg });
        let closing: Promise<void> | undefined;
        fixture.state.callbacks.onProjection = () => {
          closing ??= fixture.host.close();
        };
        try {
          await expect(
            withPluginRuntimeRegistryScope(inspection.registry, fixture.prepare),
          ).rejects.toThrow("Plugin SDK resource host is closed");
          await closing;
          await inspection.release();
          expect(fixture.state.connections[0]?.disposals).toBe(1);
        } finally {
          await inspection.release();
        }
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("joins tracked directive work before closing borrowed SQLite resources", async () => {
    const fixture = createPreparationFixture();
    try {
      await fixture.withEnvironment(async () => {
        useNoBundledPlugins();
        const inspection = await acquirePluginRegistryForInspection({ config: fixture.cfg });
        fixture.state.callbacks.trackTail = true;
        try {
          await withPluginRuntimeRegistryScope(inspection.registry, fixture.prepare);
          expect(fixture.state.tails.length).toBe(1);
          await inspection.release();
          let closed = false;
          const closing = fixture.host.close().then(() => {
            closed = true;
          });
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(closed).toBe(false);
          expect(fixture.state.connections[0]?.database.isOpen).toBe(true);
          fixture.state.tailResume.resolve();
          await Promise.all(fixture.state.tails);
          await closing;
          expect(fixture.state.connections[0]?.disposals).toBe(1);
        } finally {
          fixture.state.tailResume.resolve();
          await Promise.allSettled(fixture.state.tails);
          await inspection.release();
        }
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["active", "cold"] as const)(
    "preserves %s raw registration lifetime and cache reuse",
    async (mode) => {
      const fixture = createPreparationFixture();
      try {
        await fixture.withEnvironment(async () => {
          useNoBundledPlugins();
          const registry =
            mode === "active" ? loadPluginRegistryHandle({ config: fixture.cfg }) : undefined;
          for (let index = 0; index < 4; index++) {
            const result = await withPluginRuntimeRegistryScope(registry, fixture.prepare);
            expect(result.directives.hasDirective).toBe(true);
          }
          expect(fixture.state.connections.length).toBe(1);
          await fixture.host.close();
          expect(fixture.state.connections[0]?.database.isOpen).toBe(true);
          expect(fixture.state.connections[0]?.disposals).toBe(0);
          if (registry) {
            const lifecycle = registry.runtimeLifecycles.find(
              (entry) => entry.lifecycle.id === "speech-preparation-resource",
            );
            await lifecycle?.lifecycle.cleanup?.({ reason: "restart" });
            expect(fixture.state.connections[0]?.cleanups).toBe(1);
          }
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("rejects new preparation after the SDK host closes", async () => {
    const fixture = createPreparationFixture();
    try {
      await fixture.withEnvironment(async () => {
        useNoBundledPlugins();
        await fixture.host.close();
        await expect(fixture.prepare().then(() => undefined)).rejects.toThrow(
          "Plugin SDK resource host is closed",
        );
        expect(fixture.state.connections.length).toBe(0);
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
