import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createDeferredCore } from "../shared/deferred.js";
import {
  makePluginLoaderTempDir,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import type { MigrationPlan } from "./types.js";

type Connection = { database: DatabaseSync; disposals: number };
let fixtureId = 0;

export function createMigrationResourceFixture(
  options: {
    failApply?: boolean;
    configPatch?: boolean;
    secondProvider?: boolean;
    pausePlan?: boolean;
    detectFound?: boolean;
  } = {},
) {
  useNoBundledPlugins();
  const id = `migration-resource-${fixtureId++}`;
  const key = `__openclaw_${id}`;
  const root = fs.realpathSync(makePluginLoaderTempDir());
  const state = {
    connections: [] as Connection[],
    applying: createDeferredCore(),
    planning: createDeferredCore(),
    resumePlan: createDeferredCore(),
    planFinished: createDeferredCore(),
    planCalls: 0,
    labelError: new Error("Synthetic active provider label failed"),
    failLabel: false,
    failPlan: false,
    preparedConnections: new Map<string, Connection>(),
    preparationOwners: [] as Array<{
      providerId: string;
      prepared: Connection | undefined;
      applied: Connection;
    }>,
    resumeApply: createDeferredCore(),
    preparationDisposing: createDeferredCore(),
    finishPreparation: createDeferredCore(),
    preparationDisposals: 0,
    failPreparationDisposal: false,
    preparationError: new Error("Synthetic preparation disposal failed"),
    patchReads: 0,
    jsonReads: 0,
    applyCalls: 0,
    failCleanup: false,
    failCleanupOnConnection: 0,
    failEncoding: false,
    planned: undefined as MigrationPlan | undefined,
    applied: undefined as MigrationPlan | undefined,
  };
  Object.defineProperty(globalThis, key, { value: state, configurable: true });
  const plugin = writePlugin({
    id,
    dir: path.join(root, "plugin"),
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = {
  id: ${JSON.stringify(id)},
  register(api) {
    const state = globalThis[${JSON.stringify(key)}];
    const database = new DatabaseSync(${JSON.stringify(path.join(root, "source.sqlite"))});
    database.exec("CREATE TABLE IF NOT EXISTS imports (id INTEGER PRIMARY KEY)");
    const connection = { database, disposals: 0 };
    const connectionNumber = state.connections.push(connection);
    api.registerRuntimeLifecycle({ id: "migration-source", dispose() {
      connection.disposals++;
      database.close();
      if (state.failCleanup || state.failCleanupOnConnection === connectionNumber) throw new Error("Synthetic migration cleanup failed");
    }});
    const metadata = { read: () => database.prepare("SELECT 42 AS value").get().value };
    for (const providerId of ${JSON.stringify(options.secondProvider ? [id, id + "-second"] : [id])}) {
    api.registerMigrationProvider({
      id: providerId,
      get label() { if (state.failLabel) throw state.labelError; return "Native migration fixture"; },
      get description() { return "Native source " + database.prepare("SELECT 42 AS value").get().value; },
      supportedItemKinds: ["memory"],
      detect() { return { found: ${options.detectFound !== false}, confidence: "high", source: "synthetic-source" }; },
      prepareApply() { state.preparedConnections.set(providerId, connection); return { async dispose() {
        state.preparationDisposing.resolve();
        await state.finishPreparation.promise;
        database.prepare("SELECT 42 AS value").get();
        state.preparationDisposals++;
        if (state.failPreparationDisposal) throw state.preparationError;
      }}; },
      async plan() {
        state.planCalls++;
        if (${options.pausePlan === true}) {
          state.planning.resolve();
          try {
            await state.resumePlan.promise;
            database.prepare("SELECT 42 AS value").get();
            if (state.failPlan) throw new Error("Synthetic later plan failed");
          } finally { state.planFinished.resolve(); }
        }
        const plan = {
          providerId, source: "synthetic-source",
          summary: { total: 1, planned: 1, migrated: 0, skipped: 0, conflicts: 0, errors: 0, sensitive: 0 },
          items: [${
            options.configPatch
              ? `{
            id: "config:heartbeat", kind: "config", action: "merge", status: "planned",
            details: { path: ["agents", "defaults", "heartbeat", "every"], get value() {
              state.patchReads++;
              return (database.prepare("SELECT 42 AS value").get().value + (providerId.endsWith("-second") ? 1 : 0)) + "m";
            } },
          }`
              : '{ id: "memory:one", kind: "memory", action: "copy", status: "planned" }'
          }],
          metadata,
        };
        state.planned = plan;
        return plan;
      },
      async apply(ctx, plan) {
        state.applied = plan;
        state.applyCalls++;
        if (${options.secondProvider === true}) {
          state.preparationOwners.push({ providerId, prepared: state.preparedConnections.get(providerId), applied: connection });
        }
        if (plan.metadata !== metadata || plan.metadata.read() !== 42) {
          throw new Error("Migration lost its provider-owned plan metadata");
        }
        state.applying.resolve();
        await state.resumeApply.promise;
        database.prepare("SELECT 42 AS value").get();
        if (${options.failApply === true}) throw new Error("Synthetic migration apply failed");
        database.prepare("INSERT INTO imports DEFAULT VALUES").run();
        return {
          ...plan,
          summary: { ...plan.summary, planned: 0, migrated: 1 },
          items: plan.items.map(item => ({ ...item, status: "migrated",
            ...(item.kind === "memory" ? { details: { toJSON() {
              state.jsonReads++;
              const row = database.prepare("SELECT 42 AS value").get();
              if (state.failEncoding) throw new Error("Synthetic result encoding failed");
              return { value: row.value };
            } } } : {}),
          })),
        };
      },
    });
    }
  },
};`,
  });
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      contracts: { migrationProviders: options.secondProvider ? [id, `${id}-second`] : [id] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  return {
    id,
    root,
    state,
    config: {
      agents: {
        defaults: { workspace: path.join(root, "workspace") },
        list: [{ id: "main", default: true }],
      },
      plugins: {
        allow: [id],
        load: { paths: [plugin.file] },
        entries: { [id]: { enabled: true } },
        slots: { memory: "none" },
      },
    },
    cleanup() {
      for (const { database } of state.connections) {
        if (database.isOpen) {
          database.close();
        }
      }
      state.resumePlan.resolve();
      state.finishPreparation.resolve();
      Reflect.deleteProperty(globalThis, key);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
