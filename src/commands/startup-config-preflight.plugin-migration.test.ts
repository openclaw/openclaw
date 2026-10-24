import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { prepareGatewayPluginLoad } from "../gateway/server-plugin-bootstrap.js";
import {
  readDeferredPluginMigrationsAsync,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import * as sql from "../infra/kysely-sync.js";
import { loadOpenClawPlugins, loadOpenClawPluginsAsync } from "../plugins/loader.js";
import {
  createPluginCache,
  retirePluginCache,
  withPluginCache,
  type PluginCache,
} from "../plugins/plugin-cache.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { getPluginRuntimeLoadContextState } from "../plugins/runtime/load-context-state.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

it("defers runtime evaluation until Doctor migrates a startup plugin's retained data", async () => {
  await withDoctorConfigPreflightHome((home) =>
    withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
      const pluginId = "pending-data-fixture";
      const root = path.join(home, "fixture-plugin");
      const legacyPath = path.join(home, "legacy.json");
      const currentPath = path.join(home, "current.json");
      const evaluatedPath = path.join(home, "runtime-evaluated");
      const registeredPath = path.join(home, "registered.json");
      const retained = [
        { id: "alpha", age: 37 },
        { id: "beta", age: 64 },
      ];
      const legacyBytes = JSON.stringify(retained);
      const config = {
        meta: { migrations: { webhookListeners: true as const } },
        gateway: { mode: "local" as const },
        plugins: {
          allow: [pluginId],
          load: { paths: [root] },
          entries: { [pluginId]: { enabled: true, config: { label: "operator label" } } },
        },
      };
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(config));
      await fs.writeFile(legacyPath, legacyBytes);
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "@example/pending-data-fixture",
          version: "2.1.0",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      await fs.writeFile(
        path.join(root, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          activation: { onStartup: true },
          configSchema: {
            type: "object",
            additionalProperties: false,
            properties: { label: { type: "string" } },
          },
          doctorContract: { stateMigrations: [{ id: "retained-records" }] },
        }),
      );
      await fs.writeFile(
        path.join(root, "index.cjs"),
        `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(evaluatedPath)}, "evaluated");
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    const records = JSON.parse(fs.readFileSync(${JSON.stringify(currentPath)}, "utf8"));
    fs.writeFileSync(${JSON.stringify(registeredPath)}, JSON.stringify({
      records, label: api.pluginConfig.label
    }));
  }
};
`,
      );
      await fs.writeFile(
        path.join(root, "doctor-contract-api.cjs"),
        `const fs = require("node:fs");
module.exports = { stateMigrations: [{
  id: "retained-records", label: "Retained fixture records",
  detectLegacyState: () => fs.existsSync(${JSON.stringify(legacyPath)})
    ? { preview: ["Convert retained fixture records"] } : null,
  migrateLegacyState: () => {
    fs.copyFileSync(${JSON.stringify(legacyPath)}, ${JSON.stringify(currentPath)});
    fs.unlinkSync(${JSON.stringify(legacyPath)});
    return { changes: ["Converted retained fixture records"], warnings: [] };
  }
}] };
`,
      );
      await seedInstalledPluginIndex(
        { [pluginId]: { source: "path", installPath: root, sourcePath: root, version: "2.1.0" } },
        { config },
      );
      const pending = {
        pending: [
          {
            pluginId,
            reason: "The replacement package still needs its data migration",
            command: "openclaw doctor --fix",
            requiresStateMigration: true as const,
          },
        ],
      };
      const caches: PluginCache[] = [];
      const registries: PluginRegistry[] = [];
      const load = async () => {
        const startup = await runStartupConfigPreflight({ gateway: true, observe: false });
        expect(startup.snapshot.valid).toBe(true);
        const cache = startup.pluginCache ?? createPluginCache();
        caches.push(cache);
        return withPluginCache(cache, async () => {
          const lookup = loadPluginLookUpTable({
            config: startup.baseConfig,
            env: process.env,
            metadataSnapshot: startup.pluginMetadataSnapshot,
          });
          expect(lookup.startup.pluginIds).toContain(pluginId);
          const registry = await loadOpenClawPluginsAsync({
            config: startup.baseConfig,
            metadataSnapshot: lookup,
            onlyPluginIds: lookup.startup.pluginIds,
            activate: false,
            runtimeSideEffects: true,
          });
          registries.push(registry);
          return { registry, cache, lookup };
        });
      };
      try {
        const replacementSource = await fs.readFile(path.join(root, "index.cjs"), "utf8");
        await fs.writeFile(
          path.join(root, "index.cjs"),
          `const fs = require("node:fs");
module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
  api.registerGatewayMethod("retained.probe", ({ respond }) =>
    respond(true, JSON.parse(fs.readFileSync(${JSON.stringify(legacyPath)}, "utf8"))));
} };`,
        );
        const previous = await load();
        await fs.writeFile(path.join(root, "index.cjs"), replacementSource);
        await recordDeferredPluginMigrations(pending);
        const held = await load();
        const heldRecord = held.registry.plugins.find((record) => record.id === pluginId);
        expect(heldRecord).toMatchObject({
          status: "error",
          activated: false,
          activationReason: "configured-unavailable: pending-state-migration",
        });
        expect(heldRecord?.error).toContain("openclaw doctor --fix");
        const log = { info() {}, warn() {}, error() {}, debug() {} };
        await expect(
          withPluginCache(held.cache, () =>
            prepareGatewayPluginLoad({
              cfg: config,
              pluginIds: [pluginId],
              pluginLookUpTable: held.lookup,
              baseMethods: [],
              loadIntent: "replacement",
              previousRegistry: previous.registry,
              replacePluginIds: new Set([pluginId]),
              loadModules: false,
              log,
            }),
          ),
        ).rejects.toThrow("migration");
        const handler = previous.registry.gatewayHandlers["retained.probe"];
        assert(handler);
        const respond = vi.fn();
        await handler({
          req: { type: "req", id: "retained", method: "retained.probe" },
          params: {},
          client: null,
          isWebchatConnect: () => false,
          respond,
          context: {} as Parameters<typeof handler>[0]["context"],
        });
        expect(respond).toHaveBeenCalledWith(true, retained, undefined, undefined);
        await expect(fs.stat(evaluatedPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(legacyPath, "utf8")).toBe(legacyBytes);
        expect(await fs.readFile(configPath, "utf8")).toBe(JSON.stringify(config));
        await runDoctorConfigPreflight({
          migrateLegacyConfig: false,
          invalidConfigNote: false,
          doctorOnlyStateMigrations: true,
          repairPrefixedConfig: true,
        });
        expect(await readDeferredPluginMigrationsAsync()).toEqual([]);
        const retried = await withPluginCache(held.cache, () =>
          loadOpenClawPluginsAsync({
            config,
            metadataSnapshot: held.lookup,
            onlyPluginIds: [pluginId],
            activate: false,
            runtimeSideEffects: true,
          }),
        );
        registries.push(retried);
        expect(retried.plugins.find((record) => record.id === pluginId)?.status).toBe("loaded");
        const ready = await load();
        expect(ready.registry.plugins.find((record) => record.id === pluginId)).toMatchObject({
          status: "loaded",
          activated: true,
        });
        expect(JSON.parse(await fs.readFile(registeredPath, "utf8"))).toEqual({
          records: retained,
          label: "operator label",
        });
        writeConfigMachineState("fixture.unrelated", true);
        const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
        const mainQueries = vi.spyOn(sql, "executeSqliteQuerySync");
        try {
          for (const loader of [loadOpenClawPluginsAsync, loadOpenClawPlugins]) {
            const cache = createPluginCache();
            caches.push(cache);
            const registry = await withPluginCache(cache, () =>
              loader({
                config,
                metadataSnapshot: ready.lookup,
                onlyPluginIds: [pluginId],
                activate: false,
                cache: false,
                runtimeSideEffects: true,
              }),
            );
            registries.push(registry);
            expect(registry.plugins.find((record) => record.id === pluginId)?.status).toBe(
              "loaded",
            );
          }
          expect(
            reads.mock.calls.filter(
              ([, command]) => command.type === "plugins.deferredMigrations.read",
            ),
          ).toHaveLength(0);
          expect(
            mainQueries.mock.calls.filter(([, query]) =>
              query.compile().sql.includes('"migration_runs"'),
            ),
          ).toHaveLength(0);
        } finally {
          reads.mockRestore();
          mainQueries.mockRestore();
        }
      } finally {
        for (const registry of registries.toReversed()) {
          await disposePluginRegistryInstances(registry);
        }
        for (const cache of caches) {
          await retirePluginCache(cache);
        }
      }
    }),
  );
});

it("holds a divergent selected engine owner until Doctor migrates its retained data", async () => {
  await withDoctorConfigPreflightHome((home) =>
    withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
      const pluginId = "pending-engine-owner";
      const engineId = "Pending-Engine";
      const root = path.join(home, "engine-plugin");
      const legacyPath = path.join(home, "engine-legacy.json");
      const currentPath = path.join(home, "engine-current.json");
      const evaluatedPath = path.join(home, "engine-evaluated");
      const config = {
        gateway: { mode: "local" as const },
        plugins: {
          allow: [pluginId],
          load: { paths: [root] },
          entries: { [pluginId]: { enabled: true } },
          slots: { contextEngine: engineId },
        },
      };
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
      await fs.writeFile(path.join(home, ".openclaw", "openclaw.json"), JSON.stringify(config));
      await fs.writeFile(legacyPath, "[]");
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "@example/pending-engine-owner",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      await fs.writeFile(
        path.join(root, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          kind: "context-engine",
          contextEngineIds: [engineId],
          activation: { onStartup: true },
          configSchema: { type: "object", additionalProperties: false },
          doctorContract: { stateMigrations: [{ id: "engine-records" }] },
        }),
      );
      await fs.writeFile(
        path.join(root, "index.cjs"),
        `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(evaluatedPath)}, "evaluated");
module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
  fs.readFileSync(${JSON.stringify(currentPath)}, "utf8");
  api.registerContextEngine(${JSON.stringify(engineId)}, () => { throw new Error("not resolved"); });
} };
`,
      );
      await fs.writeFile(
        path.join(root, "doctor-contract-api.cjs"),
        `const fs = require("node:fs");
module.exports = { stateMigrations: [{
  id: "engine-records", label: "Engine fixture records",
  detectLegacyState: () => fs.existsSync(${JSON.stringify(legacyPath)})
    ? { preview: ["Convert engine fixture records"] } : null,
  migrateLegacyState: () => {
    fs.renameSync(${JSON.stringify(legacyPath)}, ${JSON.stringify(currentPath)});
    return { changes: ["Converted engine fixture records"], warnings: [] };
  }
}] };
`,
      );
      await seedInstalledPluginIndex(
        { [pluginId]: { source: "path", installPath: root, sourcePath: root } },
        { config },
      );
      await recordDeferredPluginMigrations({
        pending: [
          {
            pluginId,
            reason: "The engine owner still needs its data migration",
            command: "openclaw doctor --fix",
            requiresStateMigration: true as const,
          },
        ],
      });
      const registries: PluginRegistry[] = [];
      const load = async () => {
        const registry = await loadOpenClawPluginsAsync({
          config,
          onlyPluginIds: [pluginId],
          activate: false,
          cache: false,
          runtimeSideEffects: true,
        });
        registries.push(registry);
        return registry;
      };
      try {
        const held = await load();
        expect(held.plugins.find((record) => record.id === pluginId)).toMatchObject({
          status: "error",
          activationReason: "configured-unavailable: pending-state-migration",
        });
        // Admission still names the declared owner, but its module never runs before migration.
        expect(getPluginRuntimeLoadContextState(held)?.selectedContextEngine).toEqual({
          engineId,
          owner: `plugin:${pluginId}`,
        });
        expect(held.contextEngines.has(engineId)).toBe(false);
        await expect(fs.stat(evaluatedPath)).rejects.toMatchObject({ code: "ENOENT" });
        await runDoctorConfigPreflight({
          migrateLegacyConfig: false,
          invalidConfigNote: false,
          doctorOnlyStateMigrations: true,
          repairPrefixedConfig: true,
        });
        expect(await readDeferredPluginMigrationsAsync()).toEqual([]);
        const ready = await load();
        expect(ready.plugins.find((record) => record.id === pluginId)?.status).toBe("loaded");
        expect(ready.contextEngines.get(engineId)?.owner).toBe(`plugin:${pluginId}`);
      } finally {
        for (const registry of registries.toReversed()) {
          await disposePluginRegistryInstances(registry);
        }
      }
    }),
  );
});
