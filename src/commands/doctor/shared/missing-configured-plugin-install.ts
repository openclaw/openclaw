// Public Doctor configured-plugin install repair facade.
export {
  configuredPluginInstallIssueToHealthFinding,
  configuredPluginInstallIssueToRepairEffect,
  detectConfiguredPluginInstallHealthIssues,
} from "./missing-configured-plugin-install.health.js";
export {
  isMissingPluginInstallRepairNoOpForIds,
  repairMissingConfiguredPluginInstalls,
  repairMissingPluginInstallsForIds,
} from "./missing-configured-plugin-install.repair.js";
