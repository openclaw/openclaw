import path from "node:path";
import { expect, it, vi } from "vitest";
import { collectStronglyConnectedComponents } from "../../scripts/lib/import-cycle-graph.js";
import { createRuntimeImportGraph } from "../../scripts/lib/runtime-import-closure.mjs";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { stateReadRegistry } from "./openclaw-state-read-operation-registry.js";

// mock-isolation: A ledger read must not evaluate migration writers or their runtime.
vi.mock("../infra/deferred-plugin-migrations.js", () => {
  throw new Error("Migration reads must not load the mutation owner");
});

it("keeps the state read registry's static contracts acyclic, including type imports", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const entry = "src/state/openclaw-state-read-operation-registry.ts";
  using imports = createRuntimeImportGraph(root, [entry], {
    sourceImports: true,
    includeTypeOnlyImports: true,
  });
  const graph = new Map<string, string[]>();
  const pending = [entry];
  for (const file of pending) {
    if (graph.has(file)) {
      continue;
    }
    const dependencies = imports
      .dependencies(file)
      .flatMap(({ resolvedFileName }) =>
        resolvedFileName?.startsWith(path.join(root, "src") + path.sep)
          ? [path.relative(root, resolvedFileName)]
          : [],
      );
    graph.set(file, dependencies);
    pending.push(...dependencies);
  }
  expect(collectStronglyConnectedComponents(graph)).toEqual([]);
});

it("reads pending and deferred obligations without loading migration writers", async () => {
  await stateReadRegistry.prepare("plugins.deferredMigrations.read");
  using db = openNodeSqliteDatabase(":memory:");
  const read = (includeDeferred?: boolean) =>
    stateReadRegistry.execute(
      { type: "plugins.deferredMigrations.read", input: { includeDeferred } },
      db,
    );
  expect(read()).toEqual({ type: "plugins.deferredMigrations.read", pending: [] });

  db.exec("CREATE TABLE migration_runs (id TEXT PRIMARY KEY, report_json TEXT, status TEXT)");
  const alpha = {
    pluginId: "alpha",
    reason: "Stored state needs an upgrade",
    command: "openclaw doctor --fix",
    requiresStateMigration: true,
  };
  const beta = { ...alpha, pluginId: "beta" };
  const zeta = { ...alpha, pluginId: "zeta" };
  const insert = db.prepare("INSERT INTO migration_runs VALUES (?, ?, ?)");
  for (const [id, report, status] of [
    ["deferred-plugin-migration:zeta", JSON.stringify(zeta), "pending"],
    ["deferred-plugin-migration:beta", JSON.stringify(beta), "deferred"],
    ["deferred-plugin-migration:alpha", JSON.stringify(alpha), "pending"],
    ["deferred-plugin-migration:completed", "{", "completed"],
    ["other-migration", "{", "pending"],
  ] as const) {
    insert.run(id, report, status);
  }

  expect(read()).toEqual({ type: "plugins.deferredMigrations.read", pending: [alpha, zeta] });
  expect(read(true)).toEqual({
    type: "plugins.deferredMigrations.read",
    pending: [alpha, beta, zeta],
  });
});
