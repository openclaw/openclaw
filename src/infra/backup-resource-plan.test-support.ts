import type { ActivatedPluginBackupInventory } from "../plugins/manifest-backup-resources.js";

export function pluginBackupPlanInput(stateDir: string, inventory: ActivatedPluginBackupInventory) {
  return {
    stateDir,
    configPaths: [],
    oauthDirs: [],
    workspaceDirs: [],
    excludedWorkspaceDirs: [],
    agentRoots: [],
    pluginResources: inventory.resources,
    pluginRoots: inventory.pluginRoots,
  };
}
