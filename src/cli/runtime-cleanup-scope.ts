import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentHarness } from "../agents/harness/types.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { CliPluginInvocationResources } from "./plugin-invocation-resources.js";

export type CliHarnessCleanup = {
  harnesses: Map<AgentHarness, () => Promise<void>>;
  registries: Set<PluginRegistry>;
  pluginResources?: CliPluginInvocationResources;
};

// Entry modules must stay runtime-free. Only executable bootstraps grant this scope;
// exported/programmatic CLI calls and Gateway boot retain their existing lifecycle.
const scope = resolveGlobalSingleton<AsyncLocalStorage<"process" | CliHarnessCleanup | undefined>>(
  Symbol.for("openclaw.cliRuntimeCleanup"),
  () => new AsyncLocalStorage(),
);

export function withCliProcessScope<T>(run: () => T): T {
  return scope.run("process", run);
}

export function hasCliProcessScope(): boolean {
  return scope.getStore() !== undefined;
}

/** Caller-owned programs and Gateway boot have no executable resource owner. */
export function getCliPluginInvocationResources(): CliPluginInvocationResources | undefined {
  const current = scope.getStore();
  return current && current !== "process" ? current.pluginResources : undefined;
}

/** Finalizers own their Windows descendants until executable process exit. */
export async function retainCliProcessJobUntilExit(): Promise<void> {
  if (process.platform !== "win32" || !hasCliProcessScope()) {
    return;
  }
  const [{ default: koffi }, { retainWindowsProcessJobUntilExit }] = await Promise.all([
    import("koffi"),
    import("../process/supervisor/service-child-windows-job-native.js"),
  ]);
  retainWindowsProcessJobUntilExit(koffi);
}

export function withCliCommandCleanup<T>(
  gatewayRun: boolean,
  run: (cleanup?: CliHarnessCleanup) => T,
): T {
  if (gatewayRun) {
    // Gateway owns its process lifetime; borrowed calls must not inherit CLI ownership.
    return scope.run(undefined, () => run());
  }
  if (scope.getStore() !== "process") {
    return run();
  }
  const pluginResources = new CliPluginInvocationResources();
  const sdkResourceHost = new LegacyPluginSdkResourceHost();
  pluginResources.adopt({ release: () => sdkResourceHost.close() });
  const cleanup: CliHarnessCleanup = {
    harnesses: new Map(),
    registries: new Set(),
    pluginResources,
  };
  return sdkResourceHost.run(() => scope.run(cleanup, () => run(cleanup)));
}

export function retainCliRegistryHarnesses(
  registry: PluginRegistry,
  dispose: (harness: AgentHarness) => Promise<void>,
): void {
  const current = scope.getStore();
  if (!current || current === "process") {
    return;
  }
  for (const { harness } of registry.agentHarnesses) {
    current.registries.add(registry);
    if (!current.harnesses.has(harness)) {
      // Preserve request facts as well as the exact registry binding after helpers unwind.
      current.harnesses.set(
        harness,
        AsyncLocalStorage.bind(() =>
          current.pluginResources
            ? current.pluginResources.runCleanup(() => dispose(harness))
            : dispose(harness),
        ),
      );
    }
  }
}
