import { AsyncLocalStorage } from "node:async_hooks";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

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
