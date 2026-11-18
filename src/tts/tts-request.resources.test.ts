import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { writeFixtureJson } from "../plugins/loader-fixture-builders.test-support.js";
import { acquirePluginRegistryForInspection, loadPluginRegistryHandle } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { cleanupNativeFixture, nativeFixtureEnv } from "../plugins/native-resource.test-support.js";
import { waitForPluginCacheRetirement } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { SpeechTelephonySynthesisRequest } from "./provider-types.js";
import { synthesizeSpeech, synthesizeTalkSpeech } from "./tts-synthesis.js";
import { textToSpeechTelephony } from "./tts-telephony.js";

const pcm = Buffer.from([0, 0, 32, 0, 224, 255, 0, 0]);

function createNativeSpeechFixture(
  synthesize: typeof textToSpeechTelephony | typeof synthesizeSpeech,
  id = "native-speech",
  reject = false,
  order = 10,
) {
  const dir = makePluginLoaderTempDir();
  const key = `__openclaw_speech_resources_${path.basename(dir)}`;
  const connections: Array<{
    databasePath: string;
    database: DatabaseSync;
    disposals: number;
    requests: SpeechTelephonySynthesisRequest[];
  }> = [];
  const callbacks: { onResolveConfig?: () => void; trackTail?: boolean } = {};
  const tails: Promise<void>[] = [];
  const state = {
    connections,
    configStarted: createDeferredCore(),
    prepareStarted: createDeferredCore(),
    prepareResume: createDeferredCore(),
    synthesizeStarted: createDeferredCore(),
    synthesizeResume: createDeferredCore(),
    pcm,
    callbacks,
    dir,
    tailStarted: createDeferredCore(),
    tailResume: createDeferredCore(),
    trackAsyncWork,
    tails,
  };
  Object.defineProperty(globalThis, key, { configurable: true, value: state });
  const plugin = writePlugin({
    dir,
    id,
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  const state = globalThis[${JSON.stringify(key)}];
  const registrationVoice = api.pluginConfig?.voiceId;
  const databasePath = require("node:path").join(state.dir, "speech-" + state.connections.length + ".sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE fixture (value INTEGER); INSERT INTO fixture VALUES (42)");
  const connection = { databasePath, database, disposals: 0, requests: [] };
  state.connections.push(connection);
  const read = () => database.prepare("SELECT value FROM fixture").get().value;
  api.lifecycle.registerRuntimeLifecycle({ id: "speech-resource", dispose() {
    read(); connection.disposals++; database.close();
  } });
  api.registerSpeechProvider({
    id: ${JSON.stringify(id)}, aliases: [${JSON.stringify(`${id}-alias`)}],
    label: "Native speech fixture", autoSelectOrder: ${order},
    defaultModel: "native-model", models: ["native-model"],
    resolveConfig({ rawConfig }) {
      state.configStarted.resolve();
      state.callbacks.onResolveConfig?.();
      read();
      return { model: "native-model", voiceId: "native-voice", ...(rawConfig.providers?.[${JSON.stringify(id)}] ?? {}), ...(registrationVoice === undefined ? {} : { voiceId: registrationVoice }) };
    },
    isConfigured() { read(); return true; },
    async prepareSynthesis() {
      read(); state.prepareStarted.resolve();
      await state.prepareResume.promise; read();
      return undefined;
    },
    async synthesize(request) {
      const result = await this.synthesizeTelephony(request);
      return {
        audioBuffer: result.audioBuffer,
        get outputFormat() { read(); return "pcm"; },
        get fileExtension() { read(); return ".pcm"; },
        get voiceCompatible() { read(); return false; },
      };
    },
    async synthesizeTelephony(request) {
      connection.requests.push(request); read(); state.synthesizeStarted.resolve();
      await state.synthesizeResume.promise; read();
      if (state.callbacks.trackTail) {
        state.tails.push(state.trackAsyncWork(async () => {
          state.tailStarted.resolve(); await state.tailResume.promise; read();
        }));
      }
      if (${reject}) throw new Error("native speech failure");
      return { audioBuffer: state.pcm, outputFormat: "pcm", get sampleRate() { read(); return 8000; } };
    },
  });
} };`,
  });
  writeFixtureJson(dir, "openclaw.plugin.json", {
    id,
    contracts: { speechProviders: [id] },
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: { voiceId: { type: "string" } },
    },
  });
  const cfg: OpenClawConfig = {
    plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
    tts: { provider: id, providers: { [id]: {} } },
  };
  const prefsPath = path.join(dir, "prefs.json");
  fs.writeFileSync(prefsPath, "{}");
  const resume = () => {
    state.prepareResume.resolve();
    state.synthesizeResume.resolve();
    state.tailResume.resolve();
  };
  return {
    id,
    plugin,
    cfg,
    prefsPath,
    state,
    run: (options: Partial<Parameters<typeof synthesize>[0]> = {}) =>
      synthesize({ text: "native speech", cfg, prefsPath, timeoutMs: 12345, ...options }),
    withEnvironment: (run: () => Promise<void>) => withEnvAsync(nativeFixtureEnv(dir), run),
    resume,
    cleanup() {
      resume();
      cleanupNativeFixture(key, connections);
    },
  };
}

function settle<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
}

async function waitForHook(hook: Promise<void>, operation: Promise<unknown>) {
  await Promise.race([
    hook,
    operation.then(() => {
      throw new Error("Speech settled before the expected provider hook");
    }),
  ]);
}

function combineConfig(
  primary: ReturnType<typeof createNativeSpeechFixture>,
  others: ReturnType<typeof createNativeSpeechFixture>[],
): OpenClawConfig {
  return {
    ...primary.cfg,
    plugins: {
      allow: [primary.id, ...others.map((entry) => entry.id)],
      load: { paths: [primary.plugin.file, ...others.map((entry) => entry.plugin.file)] },
      slots: { memory: "none" },
    },
  };
}

type SpeechFixture = ReturnType<typeof createNativeSpeechFixture>;

async function withFixtures(
  fixtures: [SpeechFixture, ...SpeechFixture[]],
  run: () => Promise<void>,
) {
  try {
    await fixtures[0].withEnvironment(async () => {
      useNoBundledPlugins();
      await run();
    });
  } finally {
    fixtures.forEach((fixture) => fixture.cleanup());
  }
}

function expectDisposed(fixtures: SpeechFixture[], raw = false) {
  for (const entry of fixtures.flatMap((fixture) => fixture.state.connections)) {
    expect(entry.database.isOpen).toBe(raw);
    expect(entry.disposals).toBe(raw ? 0 : 1);
  }
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe.each([
  ["telephony", textToSpeechTelephony],
  ["buffered speech", synthesizeSpeech],
  ["Talk speech", synthesizeTalkSpeech],
] as const)("%s provider registration resources", (surface, synthesize) => {
  const createFixture = (id = "native-speech", reject = false, order = 10) =>
    createNativeSpeechFixture(synthesize, id, reject, order);
  it.each([false, true])(
    "disposes cold speech resources after settlement (reject=%s)",
    async (reject) => {
      const fixture = createFixture("native-telephony", reject);
      await withFixtures([fixture], async () => {
        const result = settle(fixture.run());
        try {
          await waitForHook(fixture.state.prepareStarted.promise, result);
          expect(fixture.state.connections.length).toBeGreaterThan(0);
          expect(fixture.state.connections.every((entry) => entry.database.isOpen)).toBe(true);
          fixture.state.prepareResume.resolve();
          await waitForHook(fixture.state.synthesizeStarted.promise, result);
          fixture.state.synthesizeResume.resolve();
          const outcome = await result;
          expect(outcome.error).toBeUndefined();
          expect(outcome.value?.success).toBe(!reject);
          if (reject) {
            expect(outcome.value?.error).toContain("native speech failure");
          } else {
            expect(outcome.value?.audioBuffer).toEqual(pcm);
            expect(outcome.value).toHaveProperty(
              surface === "telephony" ? "sampleRate" : "fileExtension",
              surface === "telephony" ? 8000 : ".pcm",
            );
            expect(outcome.value?.providerVoice).toBe("native-voice");
          }
          expect(fixture.state.connections.flatMap((entry) => entry.requests)).toMatchObject([
            { timeoutMs: 12345 },
          ]);
          expectDisposed([fixture]);
        } finally {
          fixture.resume();
          await result;
        }
      });
    },
  );
});

// Talk shares the buffered request owner; settlement above covers its separate entry point.
describe.each([
  ["telephony", textToSpeechTelephony],
  ["buffered speech", synthesizeSpeech],
] as const)("%s provider selection and ownership", (_surface, synthesize) => {
  const createFixture = (id = "native-speech", reject = false, order = 10) =>
    createNativeSpeechFixture(synthesize, id, reject, order);
  it.each(["managed", "managed-config", "raw"] as const)(
    "retains the %s host through setup and synthesis",
    async (owner) => {
      const fixture = createFixture();
      await withFixtures([fixture], async () => {
        const inspection =
          owner === "raw"
            ? undefined
            : await acquirePluginRegistryForInspection({ config: fixture.cfg });
        const registry = inspection?.registry ?? loadPluginRegistryHandle({ config: fixture.cfg });
        let parentRelease: Promise<void> | undefined;
        if (owner === "managed-config") {
          fixture.state.callbacks.onResolveConfig = () => {
            parentRelease ??= inspection!.release();
          };
        }
        const result = settle(withPluginRuntimeRegistryScope(registry, fixture.run));
        try {
          await waitForHook(
            owner === "managed-config"
              ? fixture.state.configStarted.promise
              : fixture.state.prepareStarted.promise,
            result,
          );
          await (parentRelease ?? inspection?.release());
          expect(fixture.state.connections.every((entry) => entry.database.isOpen)).toBe(true);
          fixture.state.prepareResume.resolve();
          await waitForHook(fixture.state.synthesizeStarted.promise, result);
          fixture.state.synthesizeResume.resolve();
          const outcome = await result;
          expect(outcome.error).toBeUndefined();
          expect(outcome.value?.success).toBe(true);
          expect(outcome.value?.audioBuffer).toEqual(pcm);
          expectDisposed([fixture], owner === "raw");
        } finally {
          fixture.resume();
          await result;
          await inspection?.release();
        }
      });
    },
  );

  it("keeps preference-only direct providers out of the override fallback catalog", async () => {
    const catalog = createFixture("catalog-voice", false, 20);
    const override = createFixture("override-voice", true, 10);
    const preferred = createFixture("preference-voice", false, 0);
    const fixtures: [SpeechFixture, ...SpeechFixture[]] = [catalog, override, preferred];
    fixtures.forEach((fixture) => fixture.resume());
    fs.writeFileSync(
      catalog.prefsPath,
      JSON.stringify({ tts: { provider: "preference-voice-alias" } }),
    );
    await withFixtures(fixtures, async () => {
      const result = await catalog.run({
        timeoutMs: undefined,
        cfg: combineConfig(catalog, [override, preferred]),
        overrides: { provider: "override-voice-alias" },
      });
      expect(result.success).toBe(true);
      expect(result.provider).toBe("catalog-voice");
      expect(result.attemptedProviders).toEqual(["override-voice", "catalog-voice"]);
      expect(preferred.state.connections.flatMap((entry) => entry.requests).length).toBe(0);
      expectDisposed(fixtures);
    });
  });

  it("does not turn a prior override-only provider into an automatic fallback", async () => {
    const catalog = createFixture("catalog-voice", true);
    const override = createFixture("override-voice", false);
    catalog.resume();
    override.resume();
    await withFixtures([catalog, override], async () => {
      const cfg = combineConfig(catalog, [override]);
      const first = await catalog.run({
        timeoutMs: undefined,
        cfg,
        overrides: { provider: "override-voice-alias" },
      });
      expect(first.success).toBe(true);
      expect(first.provider).toBe("override-voice");
      const second = await catalog.run({ cfg, timeoutMs: undefined });
      expect(second.success).toBe(false);
      expect(second.attemptedProviders).toEqual(["catalog-voice"]);
      expect(override.state.connections.flatMap((entry) => entry.requests).length).toBe(1);
      expectDisposed([catalog, override]);
    });
  });
  it.each([true, false])(
    "keeps fallback config stable for one request and refreshes the next (runtimeOwned=%s)",
    async (runtimeOwned) => {
      const primary = createFixture("refresh-primary", true);
      const fallback = createFixture("refresh-fallback");
      primary.state.prepareResume.resolve();
      fallback.resume();
      await withFixtures([primary, fallback], async () => {
        const base = combineConfig(primary, [fallback]);
        const tts = { ...base.tts, providers: { [primary.id]: {}, [fallback.id]: {} } };
        const voiceConfig = (voiceId: string): OpenClawConfig => ({
          ...base,
          plugins: { ...base.plugins, entries: { [fallback.id]: { config: { voiceId } } } },
          tts,
        });
        const cfg = voiceConfig("before-refresh");
        setRuntimeConfigSnapshot(runtimeOwned ? cfg : { ...cfg });
        const pending = settle(primary.run({ cfg, timeoutMs: undefined }));
        try {
          await waitForHook(primary.state.synthesizeStarted.promise, pending);
          const nextConfig = voiceConfig("after-refresh");
          setRuntimeConfigSnapshot(nextConfig);
          primary.state.synthesizeResume.resolve();
          const result = await pending;
          expect(result.error).toBeUndefined();
          expect(result.value?.success).toBe(true);
          expect(result.value?.attemptedProviders).toEqual([primary.id, fallback.id]);
          expect(result.value?.providerVoice).toBe("before-refresh");
          expect(result.value?.audioBuffer).toEqual(pcm);
          const next = await primary.run({ cfg: nextConfig, timeoutMs: undefined });
          expect(next.success).toBe(true);
          expect(next.providerVoice).toBe("after-refresh");
          expectDisposed([primary, fallback]);
        } finally {
          primary.resume();
          await pending;
          clearRuntimeConfigSnapshot();
        }
      });
    },
  );
  it("joins provider work that outlives its buffered result before closing SQLite", async () => {
    const fixture = createFixture();
    fixture.state.callbacks.trackTail = true;
    fixture.state.prepareResume.resolve();
    fixture.state.synthesizeResume.resolve();
    await withFixtures([fixture], async () => {
      let settled = false;
      const pending = settle(fixture.run()).then((result) => {
        settled = true;
        return result;
      });
      try {
        await waitForHook(fixture.state.tailStarted.promise, pending);
        await nextTurn();
        expect(settled).toBe(false);
        expect(fixture.state.connections.every((entry) => entry.database.isOpen)).toBe(true);
        fixture.state.tailResume.resolve();
        const result = await pending;
        expect(result.error).toBeUndefined();
        expect(result.value?.success).toBe(true);
        expectDisposed([fixture]);
        for (const entry of fixture.state.connections) {
          using reopened = new DatabaseSync(entry.databasePath, { readOnly: true });
          expect(reopened.prepare("SELECT value FROM fixture").get()?.value).toBe(42);
        }
      } finally {
        fixture.resume();
        await pending;
        await Promise.all(fixture.state.tails);
      }
    });
  });
});

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
  const receivedOverrides: unknown[] = [];
  const state = {
    connections,
    callbacks,
    tailResume,
    tails,
    consumedVoices,
    receivedOverrides,
    trackAsyncWork,
    dir,
  };
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
      read(); state.receivedOverrides.push(request.providerOverrides.voiceSettings);
      state.consumedVoices.push(request.providerOverrides.voiceSettings.voiceId);
      return { audioBuffer: Buffer.from([42, 0]), sampleRate: 8000, outputFormat: "pcm" };
    }
  });
} };`,
  });
  writeFixtureJson(dir, "openclaw.plugin.json", {
    id,
    contracts: { speechProviders: [id] },
    configSchema: { type: "object" },
  });
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
    async runTest(this: void, run: () => Promise<void>) {
      try {
        await withEnvAsync(
          {
            ...nativeFixtureEnv(dir),
            OPENCLAW_TTS_PREFS: path.join(dir, "prefs.json"),
          },
          () =>
            host.run(async () => {
              useNoBundledPlugins();
              await run();
            }),
        );
      } finally {
        tailResume.resolve();
        await Promise.allSettled(tails);
        await host.close();
        clearPluginMetadataLifecycleCaches();
        try {
          const cleanup = await waitForPluginCacheRetirement();
          expect(cleanup.failures).toEqual([]);
        } finally {
          cleanupNativeFixture(key, connections);
        }
      }
    },
  };
}

async function withInspection(
  run: (
    fixture: ReturnType<typeof createPreparationFixture>,
    inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>,
  ) => Promise<void>,
) {
  const fixture = createPreparationFixture();
  await fixture.runTest(async () => {
    const inspection = await acquirePluginRegistryForInspection({ config: fixture.cfg });
    try {
      await run(fixture, inspection);
    } finally {
      await inspection.release();
    }
  });
}

describe("async speech preparation resources", () => {
  it("reuses registrations and preserves opaque overrides for synthesis after inspection retirement", async () => {
    await withInspection(async ({ state, host, prepare, runtime, id }, inspection) => {
      const prepared = await withPluginRuntimeRegistryScope(inspection.registry, async () => {
        const first = await prepare();
        for (let index = 0; index < 3; index++) {
          const next = await prepare();
          expect(
            next.directives.overrides.providerOverrides?.[id]?.voiceSettings ===
              first.directives.overrides.providerOverrides?.[id]?.voiceSettings,
          ).toBe(true);
        }
        const synthesis = await runtime.tts.textToSpeechTelephony({
          cfg: first.cfg,
          text: first.directives.cleanedText,
          overrides: first.directives.overrides,
        });
        expect(synthesis.success).toBe(true);
        // Ordinary dispatch must restore the handle inside its exact owning plugin.
        expect(state.receivedOverrides[0] === state.connections[0]?.opaque).toBe(true);
        return first;
      });
      expect(state.connections.length).toBe(1);
      await inspection.release();
      expect(state.connections[0]?.database.isOpen).toBe(true);
      expect(prepared.directives.overrides.providerOverrides?.[id]?.voiceSettings).toHaveProperty(
        "voiceId",
        "voice-42",
      );
      const result = await runtime.tts.textToSpeechTelephony({
        cfg: prepared.cfg,
        text: prepared.directives.cleanedText,
        overrides: prepared.directives.overrides,
      });
      expect(result.success).toBe(true);
      expect(state.consumedVoices).toEqual(["voice-42", "voice-42"]);
      await host.close();
      expect(state.connections.every((entry) => !entry.database.isOpen)).toBe(true);
      expect(state.connections.every((entry) => entry.disposals === 1)).toBe(true);
    });
  });

  it("retains the selected source before provider metadata can retire its inspection", async () => {
    await withInspection(async ({ state, host, prepare }, inspection) => {
      let retirement: Promise<void> | undefined;
      state.callbacks.onMetadata = () => {
        retirement ??= inspection.release();
      };
      const prepared = await withPluginRuntimeRegistryScope(inspection.registry, prepare);
      await retirement;
      expect(prepared.directives.hasDirective).toBe(true);
      expect(state.connections[0]?.opaque.voiceId).toBe("voice-42");
      await host.close();
      expect(state.connections[0]?.disposals).toBe(1);
    });
  });

  it.each(["dispose", "tail", "tail-failure"])(
    "joins pending %s work before closing resources",
    async (mode) => {
      await withInspection(async ({ state, host, prepare }, inspection) => {
        const disposeResume = createDeferredCore();
        let retirement: Promise<void> | undefined;
        const fails = mode !== "tail";
        if (mode === "dispose") {
          state.callbacks.onDispose = () => disposeResume.promise;
        } else {
          state.callbacks.trackTail = true;
        }
        if (fails) {
          state.callbacks.onProjection = () => {
            retirement ??= inspection.release();
            throw new Error("speech directive projection failed");
          };
        }
        try {
          const preparation = withPluginRuntimeRegistryScope(inspection.registry, prepare);
          if (fails) {
            await expect(preparation).rejects.toThrow("speech directive projection failed");
            if (mode === "tail-failure") {
              await nextTurn();
              expect(state.connections[0]?.database.isOpen).toBe(true);
            }
          } else {
            await preparation;
            expect(state.tails.length).toBe(1);
            await inspection.release();
          }
          let closed = false;
          const closing = host.close().then(() => {
            closed = true;
          });
          await nextTurn();
          expect(closed).toBe(false);
          if (mode !== "dispose") {
            expect(state.connections[0]?.database.isOpen).toBe(true);
          }
          disposeResume.resolve();
          state.tailResume.resolve();
          await Promise.all(state.tails);
          await closing;
          expect(state.connections[0]?.disposals).toBe(1);
        } finally {
          disposeResume.resolve();
          state.tailResume.resolve();
          await Promise.allSettled(state.tails);
          await retirement;
        }
      });
    },
  );

  it("rejects projection when its SDK host closes during preparation", async () => {
    await withInspection(async ({ state, host, prepare }, inspection) => {
      let closing: Promise<void> | undefined;
      state.callbacks.onProjection = () => {
        closing ??= host.close();
      };
      await expect(withPluginRuntimeRegistryScope(inspection.registry, prepare)).rejects.toThrow(
        "Plugin SDK resource host is closed",
      );
      await closing;
      await inspection.release();
      expect(state.connections[0]?.disposals).toBe(1);
    });
  });

  it.each(["active", "cold"] as const)(
    "preserves %s raw registration lifetime and cache reuse",
    async (mode) => {
      const { state, host, prepare, cfg, runTest } = createPreparationFixture();
      await runTest(async () => {
        const registry = mode === "active" ? loadPluginRegistryHandle({ config: cfg }) : undefined;
        for (let index = 0; index < 4; index++) {
          const result = await withPluginRuntimeRegistryScope(registry, prepare);
          expect(result.directives.hasDirective).toBe(true);
        }
        expect(state.connections.length).toBe(1);
        await host.close();
        expect(state.connections[0]?.database.isOpen).toBe(true);
        expect(state.connections[0]?.disposals).toBe(0);
      });
      expect(state.connections[0]?.cleanups).toBe(1);
    },
  );

  it("rejects new preparation after the SDK host closes", async () => {
    const { state, host, prepare, runTest } = createPreparationFixture();
    await runTest(async () => {
      await host.close();
      await expect(prepare().then(() => undefined)).rejects.toThrow(
        "Plugin SDK resource host is closed",
      );
      expect(state.connections.length).toBe(0);
    });
  });
});
