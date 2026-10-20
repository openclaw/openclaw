import { AsyncLocalStorage } from "node:async_hooks";
import "../plugins/plugin-source-capture-context.js";
import type { AgentHarness } from "../agents/harness/types.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { CliPluginInvocationResources } from "./plugin-invocation-resources.js";
import { installCliSignalExitHandlers, registerSignalExitGate } from "./signal-exit-barrier.js";

export type CliHarnessCleanup = {
  scheduler: GatewayScheduler;
  harnesses: Map<AgentHarness, () => Promise<void>>;
  registries: Set<PluginRegistry>;
  /** Captured before dispatch so source replacement cannot invalidate cleanup. */
  closeSkillsWatchers: () => Promise<void>;
  pluginResources?: CliPluginInvocationResources;
  /** Executable routing stays available until admitted command work has settled. */
  releaseManagedProxy?: () => Promise<void>;
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
  const { retainWindowsProcessJobUntilExit } =
    await import("../process/supervisor/service-child-windows-job-native.js");
  retainWindowsProcessJobUntilExit();
}

export async function withCliCommandCleanup<T>(
  gatewayRun: boolean,
  run: (cleanup?: CliHarnessCleanup) => T | Promise<T>,
): Promise<T> {
  if (gatewayRun) {
    // Gateway owns its process lifetime; borrowed calls must not inherit CLI ownership.
    return scope.run(undefined, () => run());
  }
  if (scope.getStore() !== "process") {
    return run();
  }
  const { GatewayScheduler } = await import("../infra/gateway-scheduler.js");
  // A command can replace its own package. Retain cleanup before it can remove
  // the files; another importer's module cache does not preserve this resolution.
  const { runCliDisposerAfterPending } = await import("./runtime-cleanup.js");
  const { closeOpenClawStateDatabaseAsync } = await import("../state/openclaw-state-db-cache.js");
  const { closeDefaultRetainedNativeWorkerSource } =
    await import("../infra/worker-native-lifecycle.js");
  const { closeSkillsWatchers } = await import("../skills/runtime/refresh.js");
  const pluginResources = new CliPluginInvocationResources();
  const releaseSignals = installCliSignalExitHandlers();
  pluginResources.adopt({ release: async () => releaseSignals() });
  const sdkResourceHost = new LegacyPluginSdkResourceHost();
  const scheduler = new GatewayScheduler();
  sdkResourceHost.bindScheduler(scheduler);
  pluginResources.adopt({ release: () => sdkResourceHost.close() });
  pluginResources.adopt({ release: () => scheduler.stop() });
  const cleanup: CliHarnessCleanup = {
    scheduler,
    harnesses: new Map(),
    registries: new Set(),
    closeSkillsWatchers,
    pluginResources,
  };
  const finished = createDeferredCore();
  const releaseExitGate = registerSignalExitGate(finished.promise, (signal) => {
    pluginResources.beginClose(
      new DOMException(`CLI stopping${signal ? ` (${signal})` : ""}`, "AbortError"),
    );
    void scheduler.stop();
  });
  try {
    return await sdkResourceHost.run(() =>
      scope.run(cleanup, async () => {
        try {
          return await run(cleanup);
        } finally {
          // Owned shutdown runs before this drain; expired disposers keep their recorded outcome.
          await runCliDisposerAfterPending("shared-state", async () => {
            await closeOpenClawStateDatabaseAsync();
            await closeDefaultRetainedNativeWorkerSource();
          });
        }
      }),
    );
  } finally {
    releaseExitGate();
    finished.resolve();
  }
}

export function retainCliRegistryHarnesses(
  registry: PluginRegistry,
  dispose: (harness: AgentHarness) => Promise<void>,
  retain: () => (() => void | Promise<void>) | undefined,
): void {
  const current = scope.getStore();
  if (!current || current === "process") {
    return;
  }
  for (const { harness } of registry.agentHarnesses) {
    if (!current.registries.has(registry)) {
      // Retain physical custody for terminal teardown, not ordinary invocation authority.
      const release = retain();
      if (release) {
        current.pluginResources?.adopt({
          release: async () => {
            await release();
          },
        });
      }
    }
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
