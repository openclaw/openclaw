import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  createPluginExecutionFrame,
  getPluginExecutionFrame,
  runWithPluginExecutionFrame,
} from "./plugin-instance-invocation.js";
import type { PluginSourceCaptureStorage } from "./plugin-instance-invocation.types.js";

export function getPluginSourceCaptureStorage(): PluginSourceCaptureStorage | undefined {
  return getPluginExecutionFrame()?.sourceCaptureStorage;
}

export function resolvePluginSourceCaptureStorage(
  stateDir?: string,
  placement?: PluginSourceCaptureStorage["placement"],
): PluginSourceCaptureStorage {
  const inherited = stateDir === undefined ? getPluginSourceCaptureStorage() : undefined;
  return Object.freeze({
    stateDir: path.resolve(stateDir ?? inherited?.stateDir ?? resolveStateDir()),
    placement: placement ?? inherited?.placement ?? "state",
  });
}

/** Capture storage outlives an inspection's private database and never redirects its writers. */
export function withPluginSourceCaptureStorage<T>(
  storage: PluginSourceCaptureStorage,
  run: () => T,
): T {
  const current = getPluginExecutionFrame();
  return runWithPluginExecutionFrame(
    createPluginExecutionFrame(
      {
        ...current,
        sourceCaptureStorage: resolvePluginSourceCaptureStorage(
          storage.stateDir,
          storage.placement,
        ),
      },
      current,
    ),
    run,
  );
}

// CLI bootstrap imports this lightweight owner before creating command scopes;
// Gateway metadata imports it before admitting requests. Lazy capture loading must
// not bind a shared maintenance timer to the first command's resources.
export const runInPluginSourceCaptureContext = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginSourceCaptureContext"),
  () => AsyncLocalStorage.snapshot(),
);

/** Executable CLI ownership follows profile selection to each acquired capture root. */
export const pluginSourceCaptureMaintenance = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginSourceCaptureMaintenance"),
  () =>
    new AsyncLocalStorage<{
      scheduler: GatewayScheduler;
      run: (operation: () => Promise<void>) => Promise<void>;
    }>(),
);
