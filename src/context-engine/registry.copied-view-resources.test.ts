import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import { createContextEngineLogicalTurnLease } from "../agents/harness/context-engine-logical-turn.js";
import { acquireAgentRuntimePluginRegistry } from "../agents/runtime-plugins.js";
import type { OpenClawConfig } from "../config/types.js";
import { getSpeechProvider } from "../plugin-sdk/speech.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { capturePluginLifecycleAuthority } from "../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { LegacyContextEngine } from "./legacy.js";
import {
  adoptRuntimeContextEngineRegistrations,
  registerContextEngineInRegistry,
} from "./registry.js";

const require = createRequire(import.meta.url);

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});

it.each(["retired-donor", "live-donor", "raw-donor"] as const)(
  "keeps a real copied view through factory and engine disposal (%s)",
  async (mode) => {
    await withOpenClawTestState(
      { prefix: "copied-engine-source-", layout: "split" },
      async (state) => {
        useNoBundledPlugins();
        const id = "copied-native-engine";
        const providerId = `${id}-reader`;
        const pluginRoot = state.path("plugin");
        fs.mkdirSync(pluginRoot, { recursive: true });
        const entry = path.join(pluginRoot, "index.cjs");
        const key = `__copied_engine_${path.basename(state.root)}`;
        const connections: Array<{
          database: DatabaseSync;
          file: string;
          mode: string;
          disposals: number;
        }> = [];
        const reads: number[] = [];
        const disposalStarted = createDeferredCore();
        const disposalResume = createDeferredCore();
        const bridge = {
          connections,
          reads,
          getSpeechProvider,
          disposalStarted,
          disposalResume,
          factoryCalls: 0,
          engineDisposals: 0,
        };
        Object.defineProperty(globalThis, key, { configurable: true, value: bridge });
        fs.writeFileSync(
          path.join(pluginRoot, "package.json"),
          JSON.stringify({
            name: id,
            version: "1.0.0",
            type: "commonjs",
            openclaw: { extensions: ["./index.cjs"] },
          }),
        );
        fs.writeFileSync(
          path.join(pluginRoot, "openclaw.plugin.json"),
          JSON.stringify({
            id,
            kind: "context-engine",
            contracts: { speechProviders: [providerId] },
            configSchema: { type: "object" },
          }),
        );
        fs.writeFileSync(
          entry,
          `
const { DatabaseSync } = require("node:sqlite");
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  const state = globalThis[${JSON.stringify(key)}];
  const file = ${JSON.stringify(state.path("source-"))} + state.connections.length + ".sqlite";
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE fixture(value INTEGER)");
  database.prepare("INSERT INTO fixture VALUES (?)").run(api.registrationMode === "full" ? 42 : 84);
  const connection = { database, file, mode: api.registrationMode, disposals: 0 };
  state.connections.push(connection);
  const read = () => {
    const value = Number(database.prepare("SELECT value FROM fixture").get().value);
    state.reads.push(value); return value;
  };
  api.lifecycle.registerRuntimeLifecycle({ id: "native-source", dispose() {
    read(); connection.disposals++; database.close();
  }, cleanup() { if (database.isOpen) database.close(); } });
  if (api.registrationMode !== "full") {
    api.registerSpeechProvider({ id: ${JSON.stringify(providerId)}, label: "Primary reader",
      isConfigured: () => true,
      async synthesize() { throw new Error("Unused native speech synthesis"); },
      async listVoices() { return [{ id: String(read()), name: "Native primary" }]; }
    });
    return;
  }
  api.registerContextEngine(${JSON.stringify(id)}, async (context) => {
    state.factoryCalls++; read();
    const provider = state.getSpeechProvider(${JSON.stringify(providerId)}, context.config);
    if (!provider?.listVoices) throw new Error("Missing public speech provider from supplying view");
    const readPrimary = async () => {
      const voices = await provider.listVoices({ cfg: context.config });
      if (voices[0]?.id !== "84") throw new Error("Factory selected another registry's provider");
    };
    await readPrimary();
    return {
      info: { id: ${JSON.stringify(id)}, name: "Copied native engine" },
      async ingest() { return { ingested: false }; },
      async assemble({ messages }) { read(); await readPrimary(); return { messages, estimatedTokens: 0 }; },
      async compact() { return { ok: true, compacted: false }; },
      async dispose() {
        state.disposalStarted.resolve(); await state.disposalResume.promise;
        read(); await readPrimary(); state.engineDisposals++;
      }
    };
  });
} };
`,
        );
        const config: OpenClawConfig = {
          plugins: {
            allow: [id],
            load: { paths: [pluginRoot] },
            slots: { memory: "none", contextEngine: id },
          },
        };
        await state.writeConfig(config);
        const donor = createPluginRegistry({
          runtime: createPluginRuntime(),
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          activateGlobalSideEffects: false,
        });
        const donorSource =
          mode === "raw-donor" ? undefined : new PluginRegistryInspectionResources();
        donorSource?.attach(donor.registry);
        const record = createPluginRecord({ id, source: entry });
        donor.registry.plugins.push(record);
        const api = donor.createApi(record, { config, registrationMode: "full" });
        const plugin: unknown = require(entry);
        if (!isRecord(plugin) || typeof plugin.register !== "function") {
          throw new Error("Invalid native plugin fixture");
        }
        const register = plugin.register;
        if (donorSource) {
          donorSource.runRegistration(id, () => register(api));
        } else {
          register(api);
        }
        setActivePluginRegistry(donor.registry);
        const donorCurrent = capturePluginLifecycleAuthority(donor.registry);
        const sdkHost = new LegacyPluginSdkResourceHost();
        let acquired: Awaited<ReturnType<typeof acquireAgentRuntimePluginRegistry>> | undefined;
        let lease: Awaited<ReturnType<typeof createContextEngineLogicalTurnLease>> | undefined;
        let disposal: Promise<void> | undefined;
        try {
          await sdkHost.run(async () => {
            acquired = await acquireAgentRuntimePluginRegistry({
              config,
              workspaceDir: state.workspaceDir,
              basePluginIds: [id],
            });
            if (!("resources" in acquired)) {
              throw new Error("Fixture did not acquire a primary inspection");
            }
            const copied = acquired.registry;
            expect(copied === acquired.primaryRegistry).toBe(false);
            expect(copied.contextEngines.get(id) === donor.registry.contextEngines.get(id)).toBe(
              true,
            );
            expect(connections.length).toBe(2);
            expect(connections[0]?.mode).toBe("full");
            expect(connections[1]?.mode).toBe("discovery");
            expect(donor.registry.contextEngines.get(id)?.lifecycle).toBe("runtime");
            if (mode === "retired-donor") {
              await donorSource?.release();
              expect(donorCurrent?.()).toBe(false);
            }
            expect(connections.every((connection) => connection.database.isOpen)).toBe(true);
            const createLease = () =>
              createContextEngineLogicalTurnLease({
                identity: { runId: "copied-source-run", sessionId: "copied-source-session" },
                config,
                workspaceDir: state.workspaceDir,
                warn: () => {},
              });
            lease = await withPluginRuntimeRegistryScope(copied, createLease);
            expect(lease.effectiveEngineId).toBe(id);
            expect(lease.degraded).toBe(false);
            expect(bridge.factoryCalls).toBe(1);
            expect(connections.length).toBe(2);
            const engine = lease.begin().engine;
            await engine.assemble({ messages: [], sessionId: "copied-source-session" });
            await acquired.releaseRegistry();
            await expect(
              withPluginRuntimeRegistryScope(copied, createLease).then(() => undefined),
            ).rejects.toThrow(/released/);
            expect(bridge.factoryCalls).toBe(1);
            disposal = lease.dispose();
            await disposalStarted.promise;
            // The fast fallback has time to release its own primary claim independently.
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            expect(connections.every((connection) => connection.database.isOpen)).toBe(true);
            disposalResume.resolve();
            await disposal;
            expect(bridge.engineDisposals).toBe(1);
            const primary = connections.find((connection) => connection.mode !== "full");
            expect(primary?.database.isOpen).toBe(false);
            expect(primary?.disposals).toBe(1);
            expect(reads.includes(42)).toBe(true);
            expect(reads.includes(84)).toBe(true);
            if (mode === "retired-donor") {
              expect(donorCurrent?.()).toBe(false);
              expect(connections[0]?.database.isOpen).toBe(false);
              expect(connections[0]?.disposals).toBe(1);
            } else {
              expect(connections[0]?.database.isOpen).toBe(true);
            }
          });
          await donorSource?.release();
          await sdkHost.close();
          for (const connection of connections) {
            const database = new DatabaseSync(connection.file, { readOnly: true });
            try {
              expect(database.prepare("SELECT value FROM fixture").get()?.value).toBe(
                connection.mode === "full" ? 42 : 84,
              );
            } finally {
              database.close();
            }
          }
        } finally {
          disposalResume.resolve();
          await (disposal ?? lease?.dispose());
          if (acquired && "releaseRegistry" in acquired) {
            await acquired.releaseRegistry();
          }
          await donorSource?.release();
          await sdkHost.close();
          for (const connection of connections) {
            if (connection.database.isOpen) {
              connection.database.close();
            }
          }
          delete require.cache[entry];
          Reflect.deleteProperty(globalThis, key);
        }
      },
    );
  },
);

it.each([false, true])(
  "does not treat an uncovered view as a retired donor's owner (failed dependency=%s)",
  async (failedDependency) => {
    const donor = createEmptyPluginRegistry();
    const target = createEmptyPluginRegistry();
    const donorSource = new PluginRegistryInspectionResources();
    const primarySource = new PluginRegistryInspectionResources();
    donorSource.attach(donor);
    primarySource.attach(target);
    const record = { id: "uncovered-engine", source: "/synthetic/uncovered-engine.cjs" };
    donor.plugins.push(createPluginRecord(record));
    target.plugins.push(createPluginRecord(record));
    let calls = 0;
    let primaryDisposals = 0;
    primarySource.register(record.id, {
      id: "primary",
      dispose() {
        primaryDisposals++;
      },
    });
    registerContextEngineInRegistry(
      donor,
      record.id,
      () => {
        calls++;
        return new LegacyContextEngine();
      },
      `plugin:${record.id}`,
    );
    const copied = adoptRuntimeContextEngineRegistrations(target, donor);
    primarySource.attach(copied);
    await donorSource.release();
    if (failedDependency) {
      expect(() => primarySource.retainDependency(donorSource)).toThrow(/released/);
    }
    let lease: Awaited<ReturnType<typeof createContextEngineLogicalTurnLease>> | undefined;
    try {
      lease = await withPluginRuntimeRegistryScope(copied, () =>
        createContextEngineLogicalTurnLease({
          identity: { runId: "uncovered-run", sessionId: "uncovered-session" },
          config: { plugins: { slots: { contextEngine: record.id } } },
          warn: () => {},
        }),
      );
      expect(lease.degraded).toBe(true);
      expect(calls).toBe(0);
      await primarySource.release();
      await lease.dispose();
      expect(primaryDisposals).toBe(1);
    } finally {
      await lease?.dispose();
      await primarySource.release();
    }
  },
);
