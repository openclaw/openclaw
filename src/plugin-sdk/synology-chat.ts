// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/synology-chat/contract-api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "synology-chat",
    artifactBasename: "contract-api.js",
  });
}

export const collectSynologyChatSecurityAuditFindings: FacadeModule["collectSynologyChatSecurityAuditFindings"] =
  ((...args) =>
    loadFacadeModule().collectSynologyChatSecurityAuditFindings(
      ...args,
    )) as FacadeModule["collectSynologyChatSecurityAuditFindings"];
