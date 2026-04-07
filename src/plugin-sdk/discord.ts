// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/discord/contract-api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "discord",
    artifactBasename: "contract-api.js",
  });
}

export const collectDiscordSecurityAuditFindings: FacadeModule["collectDiscordSecurityAuditFindings"] =
  ((...args) =>
    loadFacadeModule().collectDiscordSecurityAuditFindings(
      ...args,
    )) as FacadeModule["collectDiscordSecurityAuditFindings"];
