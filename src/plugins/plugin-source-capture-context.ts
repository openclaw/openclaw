import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { UPDATE_PLUGIN_ASSET_RECEIPT_ENV } from "../infra/update-candidate-plugin-assets.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  createPluginExecutionFrame,
  getPluginExecutionFrame,
  runWithPluginExecutionFrame,
} from "./plugin-instance-invocation.js";
import type { PluginSourceCaptureStorage } from "./plugin-instance-invocation.types.js";

export const pluginSourceCaptureOwnedRoots = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginSourceCaptureOwnedRoots"),
  () => new Set<string>(),
);

/** Snapshot builders share capture custody until their stage is retired or renamed. */
export function retainPluginSourceCaptureRoot(directory: string): () => void {
  const root = fs.realpathSync(directory);
  if (pluginSourceCaptureOwnedRoots.has(root)) {
    throw new Error(`Plugin source capture root is already owned: ${root}`);
  }
  pluginSourceCaptureOwnedRoots.add(root);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      pluginSourceCaptureOwnedRoots.delete(root);
    }
  };
}

export function getPluginSourceCaptureStorage(): PluginSourceCaptureStorage | undefined {
  return getPluginExecutionFrame()?.sourceCaptureStorage;
}

export function resolvePluginSourceCaptureStorage(
  stateDir?: string,
  placement?: PluginSourceCaptureStorage["placement"],
  privateAssetReceipt?: { value: string | undefined },
): PluginSourceCaptureStorage {
  const current = getPluginSourceCaptureStorage();
  const inherited = stateDir === undefined ? current : undefined;
  return Object.freeze({
    stateDir: path.resolve(stateDir ?? inherited?.stateDir ?? resolveStateDir()),
    placement: placement ?? inherited?.placement ?? "state",
    // Absence in an explicit selection or inherited scope is not ambient authority.
    privateAssetReceipt: privateAssetReceipt
      ? privateAssetReceipt.value
      : current
        ? current.privateAssetReceipt
        : process.env[UPDATE_PLUGIN_ASSET_RECEIPT_ENV],
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
          Object.hasOwn(storage, "privateAssetReceipt")
            ? { value: storage.privateAssetReceipt }
            : undefined,
        ),
      },
      current,
    ),
    run,
  );
}

/** Executable CLI ownership follows profile selection to each acquired capture root. */
export const pluginSourceCaptureMaintenance = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginSourceCaptureMaintenance"),
  () =>
    new AsyncLocalStorage<{
      scheduler: GatewayScheduler;
      run: (operation: () => Promise<void>) => Promise<void>;
    }>(),
);
