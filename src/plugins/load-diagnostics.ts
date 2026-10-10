import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginDiagnostic } from "./manifest-types.js";

const diagnostics = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginLoadDiagnostics"),
  () => new AsyncLocalStorage<PluginDiagnostic[]>(),
);

/** Retain observed failures after temporary inspection registries have been released. */
export function withPluginLoadDiagnostics<T>(run: (observed: PluginDiagnostic[]) => T): T {
  const observed: PluginDiagnostic[] = [];
  return diagnostics.run(observed, () => run(observed));
}

export function recordPluginLoadDiagnostic(diagnostic: PluginDiagnostic): void {
  diagnostics.getStore()?.push(diagnostic);
}
