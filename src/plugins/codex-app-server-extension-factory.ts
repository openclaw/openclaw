import { getActivePluginRegistry } from "./runtime.js";

/** Runtime id used by Codex app-server extension factories. */
export const CODEX_APP_SERVER_EXTENSION_RUNTIME_ID = "codex-app-server";

export function listCodexAppServerExtensionFactories() {
  return (
    getActivePluginRegistry()?.codexAppServerExtensionFactories?.map((entry) => entry.factory) ?? []
  );
}
