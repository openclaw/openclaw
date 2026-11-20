import path from "node:path";
import { expect, it, vi } from "vitest";
import { collectStronglyConnectedComponents } from "../../scripts/lib/import-cycle-graph.js";
import { createRuntimeImportGraph } from "../../scripts/lib/runtime-import-closure.mjs";

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

// mock-isolation: Importing the migration writer must fail to prove this read stays writer-free.
vi.mock("../infra/deferred-plugin-migrations.js", () => {
  throw new Error("Migration writer must not load for a pending-migration read");
});

it("prepares pending-migration reads without loading the migration writer", async () => {
  const { stateReadRegistry } = await import("./openclaw-state-read-operation-registry.js");
  await expect(
    stateReadRegistry.prepare("plugins.deferredMigrations.read"),
  ).resolves.toBeUndefined();
  expect(stateReadRegistry.has({ type: "plugins.deferredMigrations.read" })).toBe(true);
});
