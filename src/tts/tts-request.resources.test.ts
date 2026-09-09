import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
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
  const configStarted = createDeferredCore();
  const prepareStarted = createDeferredCore();
  const prepareResume = createDeferredCore();
  const synthesizeStarted = createDeferredCore();
  const synthesizeResume = createDeferredCore();
  const tailStarted = createDeferredCore();
  const tailResume = createDeferredCore();
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
    configStarted,
    prepareStarted,
    prepareResume,
    synthesizeStarted,
    synthesizeResume,
    pcm,
    callbacks,
    dir,
    tailStarted,
    tailResume,
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
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      contracts: { speechProviders: [id] },
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: { voiceId: { type: "string" } },
      },
    }),
  );
  const cfg: OpenClawConfig = {
    plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
    tts: { provider: id, providers: { [id]: {} } },
  };
  const prefsPath = path.join(dir, "prefs.json");
  fs.writeFileSync(prefsPath, "{}");
  return {
    id,
    plugin,
    cfg,
    prefsPath,
    state,
    run: () => synthesize({ text: "native speech", cfg, prefsPath, timeoutMs: 12345 }),
    withEnvironment: (run: () => Promise<void>) =>
      withEnvAsync(
        {
          OPENCLAW_HOME: dir,
          OPENCLAW_STATE_DIR: dir,
          OPENCLAW_CONFIG_PATH: path.join(dir, "config.json"),
        },
        run,
      ),
    resume() {
      prepareResume.resolve();
      synthesizeResume.resolve();
      tailResume.resolve();
    },
    cleanup() {
      prepareResume.resolve();
      synthesizeResume.resolve();
      tailResume.resolve();
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
      try {
        await fixture.withEnvironment(async () => {
          useNoBundledPlugins();
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
            const requests = fixture.state.connections.flatMap((entry) => entry.requests);
            expect(requests.length).toBe(1);
            expect(requests[0]?.timeoutMs).toBe(12345);
            for (const entry of fixture.state.connections) {
              expect(entry.database.isOpen).toBe(false);
              expect(entry.disposals).toBe(1);
            }
          } finally {
            fixture.resume();
            await result;
          }
        });
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each(["managed", "managed-config", "raw"] as const)(
    "retains the %s host through setup and synthesis",
    async (owner) => {
      const fixture = createFixture();
      try {
        await fixture.withEnvironment(async () => {
          useNoBundledPlugins();
          const inspection =
            owner === "raw"
              ? undefined
              : await acquirePluginRegistryForInspection({ config: fixture.cfg });
          const registry =
            inspection?.registry ?? loadPluginRegistryHandle({ config: fixture.cfg });
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
            for (const entry of fixture.state.connections) {
              expect(entry.database.isOpen).toBe(owner === "raw");
              expect(entry.disposals).toBe(owner === "raw" ? 0 : 1);
            }
          } finally {
            fixture.resume();
            await result;
            await inspection?.release();
          }
        });
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("keeps preference-only direct providers out of the override fallback catalog", async () => {
    const catalog = createFixture("catalog-voice", false, 20);
    const override = createFixture("override-voice", true, 10);
    const preferred = createFixture("preference-voice", false, 0);
    const fixtures = [catalog, override, preferred];
    fixtures.forEach((fixture) => fixture.resume());
    fs.writeFileSync(
      catalog.prefsPath,
      JSON.stringify({ tts: { provider: "preference-voice-alias" } }),
    );
    try {
      await catalog.withEnvironment(async () => {
        useNoBundledPlugins();
        const result = await synthesize({
          text: "override with configured fallback",
          cfg: combineConfig(catalog, [override, preferred]),
          prefsPath: catalog.prefsPath,
          overrides: { provider: "override-voice-alias" },
        });
        expect(result.success).toBe(true);
        expect(result.provider).toBe("catalog-voice");
        expect(result.attemptedProviders).toEqual(["override-voice", "catalog-voice"]);
        expect(preferred.state.connections.flatMap((entry) => entry.requests).length).toBe(0);
        for (const entry of fixtures.flatMap((fixture) => fixture.state.connections)) {
          expect(entry.database.isOpen).toBe(false);
          expect(entry.disposals).toBe(1);
        }
      });
    } finally {
      fixtures.forEach((fixture) => fixture.cleanup());
    }
  });

  it("does not turn a prior override-only provider into an automatic fallback", async () => {
    const catalog = createFixture("catalog-voice", true);
    const override = createFixture("override-voice", false);
    catalog.resume();
    override.resume();
    try {
      await catalog.withEnvironment(async () => {
        useNoBundledPlugins();
        const cfg = combineConfig(catalog, [override]);
        const first = await synthesize({
          text: "explicit override",
          cfg,
          prefsPath: catalog.prefsPath,
          overrides: { provider: "override-voice-alias" },
        });
        expect(first.success).toBe(true);
        expect(first.provider).toBe("override-voice");
        const second = await synthesize({
          text: "configured provider only",
          cfg,
          prefsPath: catalog.prefsPath,
        });
        expect(second.success).toBe(false);
        expect(second.attemptedProviders).toEqual(["catalog-voice"]);
        expect(override.state.connections.flatMap((entry) => entry.requests).length).toBe(1);
        for (const entry of [...catalog.state.connections, ...override.state.connections]) {
          expect(entry.database.isOpen).toBe(false);
          expect(entry.disposals).toBe(1);
        }
      });
    } finally {
      catalog.cleanup();
      override.cleanup();
    }
  });
  it("resolves fallback config from the refreshed runtime snapshot without a source snapshot", async () => {
    const primary = createFixture("refresh-primary", true);
    const fallback = createFixture("refresh-fallback");
    primary.state.prepareResume.resolve();
    fallback.resume();
    try {
      await primary.withEnvironment(async () => {
        useNoBundledPlugins();
        const base = combineConfig(primary, [fallback]);
        const cfg: OpenClawConfig = {
          ...base,
          plugins: {
            ...base.plugins,
            entries: { [fallback.id]: { config: { voiceId: "before-refresh" } } },
          },
          tts: { ...base.tts, providers: { [primary.id]: {}, [fallback.id]: {} } },
        };
        setRuntimeConfigSnapshot(cfg);
        const pending = settle(
          synthesize({
            text: "refresh during fallback",
            cfg,
            prefsPath: primary.prefsPath,
          }),
        );
        try {
          await waitForHook(primary.state.synthesizeStarted.promise, pending);
          setRuntimeConfigSnapshot({
            ...cfg,
            plugins: {
              ...cfg.plugins,
              entries: { [fallback.id]: { config: { voiceId: "after-refresh" } } },
            },
          });
          primary.state.synthesizeResume.resolve();
          const result = await pending;
          expect(result.error).toBeUndefined();
          expect(result.value?.success).toBe(true);
          expect(result.value?.attemptedProviders).toEqual([primary.id, fallback.id]);
          expect(result.value?.providerVoice).toBe("after-refresh");
          expect(result.value?.audioBuffer).toEqual(pcm);
          for (const entry of [...primary.state.connections, ...fallback.state.connections]) {
            expect(entry.database.isOpen).toBe(false);
            expect(entry.disposals).toBe(1);
          }
        } finally {
          primary.resume();
          await pending;
          clearRuntimeConfigSnapshot();
        }
      });
    } finally {
      primary.cleanup();
      fallback.cleanup();
    }
  });
  it("joins provider work that outlives its buffered result before closing SQLite", async () => {
    const fixture = createFixture();
    fixture.state.callbacks.trackTail = true;
    fixture.state.prepareResume.resolve();
    fixture.state.synthesizeResume.resolve();
    try {
      await fixture.withEnvironment(async () => {
        useNoBundledPlugins();
        let settled = false;
        const pending = settle(fixture.run()).then((result) => {
          settled = true;
          return result;
        });
        try {
          await waitForHook(fixture.state.tailStarted.promise, pending);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(settled).toBe(false);
          expect(fixture.state.connections.every((entry) => entry.database.isOpen)).toBe(true);
          fixture.state.tailResume.resolve();
          const result = await pending;
          expect(result.error).toBeUndefined();
          expect(result.value?.success).toBe(true);
          for (const entry of fixture.state.connections) {
            expect(entry.database.isOpen).toBe(false);
            expect(entry.disposals).toBe(1);
            const reopened = new DatabaseSync(entry.databasePath, { readOnly: true });
            try {
              expect(reopened.prepare("SELECT value FROM fixture").get()?.value).toBe(42);
            } finally {
              reopened.close();
            }
          }
        } finally {
          fixture.resume();
          await pending;
          await Promise.all(fixture.state.tails);
        }
      });
    } finally {
      fixture.cleanup();
    }
  });
});
