import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// CLI bootstrap imports this lightweight owner before creating command scopes;
// Gateway metadata imports it before admitting requests. Lazy capture loading must
// not bind a shared maintenance timer to the first command's resources.
export const runInPluginSourceCaptureContext = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginSourceCaptureContext"),
  () => AsyncLocalStorage.snapshot(),
);
