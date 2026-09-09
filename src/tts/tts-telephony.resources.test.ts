import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
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
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { SpeechTelephonySynthesisRequest } from "./provider-types.js";
import { textToSpeechTelephony } from "./tts-telephony.js";

const pcm = Buffer.from([0, 0, 32, 0, 224, 255, 0, 0]);

function createNativeTelephonyFixture(id = "native-telephony", reject = false, order = 10) {
  const dir = makePluginLoaderTempDir();
  const key = `__openclaw_telephony_resources_${path.basename(dir)}`;
  const configStarted = createDeferredCore();
  const prepareStarted = createDeferredCore();
  const prepareResume = createDeferredCore();
  const synthesizeStarted = createDeferredCore();
  const synthesizeResume = createDeferredCore();
  const connections: Array<{
    database: DatabaseSync;
    disposals: number;
    requests: SpeechTelephonySynthesisRequest[];
  }> = [];
  const callbacks: { onResolveConfig?: () => void } = {};
  const state = {
    connections,
    configStarted,
    prepareStarted,
    prepareResume,
    synthesizeStarted,
    synthesizeResume,
    pcm,
    callbacks,
  };
  Object.defineProperty(globalThis, key, { configurable: true, value: state });
  const plugin = writePlugin({
    dir,
    id,
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  const state = globalThis[${JSON.stringify(key)}];
  const registrationVoice = api.pluginConfig?.voiceId;
  const database = new DatabaseSync(":memory:");
  const connection = { database, disposals: 0, requests: [] };
  state.connections.push(connection);
  const read = () => database.prepare("SELECT 42 AS value").get().value;
  api.lifecycle.registerRuntimeLifecycle({ id: "telephony-resource", dispose() {
    read(); connection.disposals++; database.close();
  } });
  api.registerSpeechProvider({
    id: ${JSON.stringify(id)}, aliases: [${JSON.stringify(`${id}-alias`)}],
    label: "Native telephony fixture", autoSelectOrder: ${order},
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
    async synthesize() { throw new Error("Unexpected buffered synthesis"); },
    async synthesizeTelephony(request) {
      connection.requests.push(request); read(); state.synthesizeStarted.resolve();
      await state.synthesizeResume.promise; read();
      if (${reject}) throw new Error("native telephony failure");
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
    run: () =>
      textToSpeechTelephony({ text: "native telephony", cfg, prefsPath, timeoutMs: 12345 }),
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
    },
    cleanup() {
      prepareResume.resolve();
      synthesizeResume.resolve();
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
    operation.then((outcome) => {
      throw new Error(
        `Telephony settled before the expected provider hook: ${JSON.stringify(outcome)}`,
      );
    }),
  ]);
}

function combineConfig(
  primary: ReturnType<typeof createNativeTelephonyFixture>,
  others: ReturnType<typeof createNativeTelephonyFixture>[],
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

describe("telephony provider registration resources", () => {
  it.each([false, true])(
    "disposes cold telephony resources after settlement (reject=%s)",
    async (reject) => {
      const fixture = createNativeTelephonyFixture("native-telephony", reject);
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
              expect(outcome.value?.error).toContain("native telephony failure");
            } else {
              expect(outcome.value?.audioBuffer).toEqual(pcm);
              expect(outcome.value?.sampleRate).toBe(8000);
              expect(outcome.value?.providerVoice).toBe("native-voice");
            }
            const requests = fixture.state.connections.flatMap((entry) => entry.requests);
            expect(requests).toHaveLength(1);
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
      const fixture = createNativeTelephonyFixture();
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
    const catalog = createNativeTelephonyFixture("catalog-voice", false, 20);
    const override = createNativeTelephonyFixture("override-voice", true, 10);
    const preferred = createNativeTelephonyFixture("preference-voice", false, 0);
    const fixtures = [catalog, override, preferred];
    fixtures.forEach((fixture) => fixture.resume());
    fs.writeFileSync(
      catalog.prefsPath,
      JSON.stringify({ tts: { provider: "preference-voice-alias" } }),
    );
    try {
      await catalog.withEnvironment(async () => {
        useNoBundledPlugins();
        const result = await textToSpeechTelephony({
          text: "override with configured fallback",
          cfg: combineConfig(catalog, [override, preferred]),
          prefsPath: catalog.prefsPath,
          overrides: { provider: "override-voice-alias" },
        });
        expect(result.success).toBe(true);
        expect(result.provider).toBe("catalog-voice");
        expect(result.attemptedProviders).toEqual(["override-voice", "catalog-voice"]);
        expect(preferred.state.connections.flatMap((entry) => entry.requests)).toEqual([]);
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
    const catalog = createNativeTelephonyFixture("catalog-voice", true);
    const override = createNativeTelephonyFixture("override-voice", false);
    catalog.resume();
    override.resume();
    try {
      await catalog.withEnvironment(async () => {
        useNoBundledPlugins();
        const cfg = combineConfig(catalog, [override]);
        const first = await textToSpeechTelephony({
          text: "explicit override",
          cfg,
          prefsPath: catalog.prefsPath,
          overrides: { provider: "override-voice-alias" },
        });
        expect(first.success).toBe(true);
        expect(first.provider).toBe("override-voice");
        const second = await textToSpeechTelephony({
          text: "configured provider only",
          cfg,
          prefsPath: catalog.prefsPath,
        });
        expect(second.success).toBe(false);
        expect(second.attemptedProviders).toEqual(["catalog-voice"]);
        expect(override.state.connections.flatMap((entry) => entry.requests)).toHaveLength(1);
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
    const primary = createNativeTelephonyFixture("refresh-primary", true);
    const fallback = createNativeTelephonyFixture("refresh-fallback");
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
          textToSpeechTelephony({
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
});
