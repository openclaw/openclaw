// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/anthropic/api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "anthropic",
    artifactBasename: "api.js",
  });
}
export const CLAUDE_CLI_BACKEND_ID: FacadeModule["CLAUDE_CLI_BACKEND_ID"] =
  loadFacadeModule()["CLAUDE_CLI_BACKEND_ID"];
export const isClaudeCliProvider: FacadeModule["isClaudeCliProvider"] = ((...args) =>
  loadFacadeModule()["isClaudeCliProvider"](...args)) as FacadeModule["isClaudeCliProvider"];
