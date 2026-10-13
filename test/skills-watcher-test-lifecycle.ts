// Shared workers reset modules between files, orphaning skills watchers a file left open.
// Their re-armed timers then land on a later file's fake clock and abort its
// vi.runAllTimersAsync(). Remember each real watcher generation so the runner can close
// leftovers after the file and fail the file that leaked them.
import path from "node:path";
import {
  normalizeModuleId,
  type EvaluatedModuleNode,
  type EvaluatedModules,
} from "vite/module-runner";
import { vi } from "vitest";

const source = (name: string) => normalizeModuleId(path.resolve(import.meta.dirname, "..", name));
const refreshSource = source("src/skills/runtime/refresh.ts");
const registrySource = source("src/skills/runtime/refresh-watch-registry.ts");

type RefreshModule = typeof import("../src/skills/runtime/refresh.js");
type SkillsWatchRegistry = Pick<
  typeof import("../src/skills/runtime/refresh-watch-registry.js"),
  "pathWatchers" | "workspaceWatchOwners"
>;

type SkillsWatcherTestLifecycle = {
  generations: Map<RefreshModule["closeSkillsWatchers"], SkillsWatchRegistry>;
  beforeModuleReset: (() => void) | undefined;
};

const SKILLS_WATCHER_TEST_LIFECYCLE = Symbol.for("openclaw.skillsWatcherTestLifecycle");
const lifecycleStore = globalThis as typeof globalThis & {
  [SKILLS_WATCHER_TEST_LIFECYCLE]?: SkillsWatcherTestLifecycle;
};

function createLifecycle(): SkillsWatcherTestLifecycle {
  const state: SkillsWatcherTestLifecycle = {
    generations: new Map(),
    beforeModuleReset: undefined,
  };
  const nativeResetModules = vi.resetModules;
  vi.resetModules = () => {
    state.beforeModuleReset?.();
    return nativeResetModules();
  };
  return state;
}

// Runner/helper re-evaluation must share custody and preserve the installed reset hook.
const lifecycle = (lifecycleStore[SKILLS_WATCHER_TEST_LIFECYCLE] ??= createLifecycle());

export function setSkillsWatcherCaptureBeforeReset(capture: (() => void) | undefined): void {
  lifecycle.beforeModuleReset = capture;
}

function realExports(
  node: EvaluatedModuleNode | undefined,
  executions: ReadonlyMap<string, { external?: boolean }>,
): unknown {
  const execution =
    node && executions.get(node.id.startsWith("mock:") ? node.id.slice(5) : node.id);
  return execution && !execution.external ? node.exports : undefined;
}

export function rememberSkillsWatcherGenerations(
  modules: Pick<EvaluatedModules, "fileToModulesMap" | "idToModuleMap">,
  executions: ReadonlyMap<string, { external?: boolean }>,
): void {
  for (const node of modules.fileToModulesMap.get(refreshSource) ?? []) {
    const close = (realExports(node, executions) as Partial<RefreshModule> | undefined)
      ?.closeSkillsWatchers;
    if (typeof close !== "function" || vi.isMockFunction(close)) {
      continue;
    }
    // Same-file instances (query or importActual variants) can coexist; pair each closer
    // with the registry instance its own evaluation imported.
    for (const id of node.imports) {
      const dependency = modules.idToModuleMap.get(id);
      if (dependency?.file !== registrySource) {
        continue;
      }
      const registry = realExports(dependency, executions) as
        | Partial<SkillsWatchRegistry>
        | undefined;
      const { pathWatchers, workspaceWatchOwners } = registry ?? {};
      if (pathWatchers instanceof Map && workspaceWatchOwners instanceof Map) {
        lifecycle.generations.set(close, { pathWatchers, workspaceWatchOwners });
      }
      break;
    }
  }
}

/** Closes every remembered generation's open watchers and returns their live entry count. */
export async function closeLeakedSkillsWatchers(): Promise<number> {
  const remembered = [...lifecycle.generations];
  lifecycle.generations.clear();
  let leaked = 0;
  const failures: unknown[] = [];
  for (const [close, registry] of remembered) {
    // Retiring watchers are already aborted; owners and path watchers can still re-arm.
    const live = registry.workspaceWatchOwners.size + registry.pathWatchers.size;
    if (live > 0) {
      leaked += live;
      // One failed shutdown must not leave the remaining generations open.
      await close(true).catch((error: unknown) => failures.push(error));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Closing ${leaked} leaked skills watch entries failed`);
  }
  return leaked;
}
