import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createContextEngineLogicalTurnLease as createLease } from "../agents/harness/context-engine-logical-turn.js";
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
import { retireInspectionInstances } from "../plugins/registry-inspection.test-support.js";
import { capturePluginLifecycleAuthority } from "../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope as withRegistry } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { LegacyContextEngine } from "./legacy.js";
import {
  adoptRuntimeContextEngineRegistrations,
  registerContextEngineInRegistry as registerEngine,
  type ContextEngineFactory,
} from "./registry.js";

const require = createRequire(import.meta.url);

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});

it.each(["retired-donor", "raw-donor"] as const)(
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
        const writeJson = (file: string, value: unknown) =>
          fs.writeFileSync(path.join(pluginRoot, file), JSON.stringify(value));
        writeJson("package.json", {
          name: id,
          version: "1.0.0",
          type: "commonjs",
          openclaw: { extensions: ["./index.cjs"] },
        });
        writeJson("openclaw.plugin.json", {
          id,
          kind: "context-engine",
          contracts: { speechProviders: [providerId] },
          configSchema: { type: "object" },
        });
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
          mode === "raw-donor"
            ? undefined
            : new PluginRegistryInspectionResources(retireInspectionInstances);
        donorSource?.attach(donor.registry);
        const record = createPluginRecord({ id, source: entry });
        donor.registry.plugins.push(record);
        const api = donor.createApi(record, { config, registrationMode: "full" });
        const plugin: unknown = require(entry);
        if (!isRecord(plugin) || typeof plugin.register !== "function") {
          throw new Error("Invalid native plugin fixture");
        }
        const registerPlugin = plugin.register;
        const register = () => registerPlugin(api);
        if (donorSource) {
          donorSource.runRegistration(id, register);
        } else {
          register();
        }
        setActivePluginRegistry(donor.registry);
        const donorCurrent = capturePluginLifecycleAuthority(donor.registry);
        const sdkHost = new LegacyPluginSdkResourceHost();
        let acquired: Awaited<ReturnType<typeof acquireAgentRuntimePluginRegistry>> | undefined;
        let lease: Awaited<ReturnType<typeof createLease>> | undefined;
        let disposal: Promise<void> | undefined;
        using warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
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
            expect(copied).not.toBe(acquired.primaryRegistry);
            expect(copied.contextEngines.get(id)).toBe(donor.registry.contextEngines.get(id));
            expect(connections).toMatchObject([{ mode: "full" }, { mode: "discovery" }]);
            expect(donor.registry.contextEngines.get(id)?.lifecycle).toBe("runtime");
            if (mode === "retired-donor") {
              await donorSource?.release();
              expect(donorCurrent?.()).toBe(false);
            }
            expect(connections.every((connection) => connection.database.isOpen)).toBe(true);
            const openLease = () =>
              createLease({
                identity: { runId: "copied-source-run", sessionId: "copied-source-session" },
                config,
                workspaceDir: state.workspaceDir,
              });
            lease = await withRegistry(copied, openLease);
            expect(
              lease.effectiveEngineId,
              warnings.mock.calls.map(([message]) => message).join("\n"),
            ).toBe(id);
            expect(lease.degraded).toBe(false);
            expect(bridge.factoryCalls).toBe(1);
            expect(connections.length).toBe(2);
            const engine = lease.begin().engine;
            await engine.assemble({ messages: [], sessionId: "copied-source-session" });
            await acquired.releaseRegistry();
            await expect(withRegistry(copied, openLease).then(() => undefined)).rejects.toThrow(
              /released/,
            );
            expect(bridge.factoryCalls).toBe(1);
            disposal = lease.dispose();
            await disposalStarted.promise;
            // The fast fallback has time to release its own primary claim independently.
            await nextEventLoopTurn();
            expect(connections.every((connection) => connection.database.isOpen)).toBe(true);
            disposalResume.resolve();
            await disposal;
            expect(bridge.engineDisposals).toBe(1);
            const primary = connections.find((connection) => connection.mode !== "full");
            expect(primary).toMatchObject({ database: { isOpen: false }, disposals: 1 });
            expect(reads).toEqual(expect.arrayContaining([42, 84]));
            if (mode === "retired-donor") {
              expect(donorCurrent?.()).toBe(false);
              expect(connections[0]).toMatchObject({ database: { isOpen: false }, disposals: 1 });
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

it("does not treat an uncovered view as a retired donor's owner after a failed dependency", async () => {
  const donor = createEmptyPluginRegistry();
  const target = createEmptyPluginRegistry();
  const donorSource = new PluginRegistryInspectionResources(retireInspectionInstances);
  const primarySource = new PluginRegistryInspectionResources(retireInspectionInstances);
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
  registerEngine(
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
  expect(() => primarySource.retainDependency(donorSource)).toThrow(/released/);
  let lease: Awaited<ReturnType<typeof createLease>> | undefined;
  try {
    lease = await withRegistry(copied, () =>
      createLease({
        identity: { runId: "uncovered-run", sessionId: "uncovered-session" },
        config: { plugins: { slots: { contextEngine: record.id } } },
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
});

const unusedFactory: ContextEngineFactory = async () => {
  throw new Error("context engine factory should not run");
};

function registryWithPluginEngine(
  params: {
    lifecycle?: "runtime" | "readOnlyDiscovery" | null;
    source?: string;
    status?: "loaded" | "disabled" | "error";
    factory?: ContextEngineFactory;
  } = {},
) {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(
    createPluginRecord({
      id: "ce-probe",
      source: params.source ?? "/tmp/ce-probe",
      status: params.status ?? "loaded",
    }),
  );
  if (params.lifecycle !== null) {
    registry.contextEngines.set("ce-probe", {
      factory: params.factory ?? unusedFactory,
      owner: "plugin:ce-probe",
      lifecycle: params.lifecycle ?? "runtime",
    });
  }
  return registry;
}

it.each([
  ["readOnlyDiscovery", "/tmp/ce-probe", "loaded", false],
  ["runtime", "/tmp/ce-probe", "loaded", false],
  [null, "/tmp/shadow-ce-probe", "loaded", false],
  [null, "/tmp/ce-probe", "disabled", true],
] as const)(
  "adopts only matching discovery entries (%s, %s, %s)",
  (lifecycle, source, status, core) => {
    const scopedFactory = vi.fn(unusedFactory);
    const rootFactory = vi.fn(unusedFactory);
    const scoped = registryWithPluginEngine({ lifecycle, source, status, factory: scopedFactory });
    const root = registryWithPluginEngine({ factory: rootFactory });
    if (core) {
      root.contextEngines.set("legacy", {
        factory: unusedFactory,
        owner: "core",
        lifecycle: "runtime",
      });
    }
    const adopted = adoptRuntimeContextEngineRegistrations(scoped, root);
    const original = lifecycle === null ? undefined : scopedFactory;
    const expected = lifecycle === "readOnlyDiscovery" ? rootFactory : original;
    expect(scoped.contextEngines.get("ce-probe")?.factory).toBe(original);
    expect(adopted.contextEngines.get("ce-probe")?.factory).toBe(expected);
    if (lifecycle !== null) {
      expect(adopted.contextEngines.get("ce-probe")?.lifecycle).toBe("runtime");
    }
    if (lifecycle !== "readOnlyDiscovery") {
      expect(adopted).toBe(scoped);
    }
  },
);
