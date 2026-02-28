/**
 * Re-export barrel for security audit collector functions.
 *
 * Maintains backward compatibility with existing imports from audit-extra.
 * Implementation split into:
 * - audit-extra.sync.ts: Config-based checks (no I/O)
 * - audit-extra.async.ts: Filesystem/plugin checks (async I/O)
 */

// Sync collectors
export {
  collectAttackSurfaceSummaryFindings,
  collectExposureMatrixFindings,
  collectGatewayHttpNoAuthFindings,
  collectGatewayHttpSessionKeyOverrideFindings,
  collectHooksHardeningFindings,
  collectLikelyMultiUserSetupFindings,
  collectMinimalProfileOverrideFindings,
  collectModelHygieneFindings,
  collectNodeDangerousAllowCommandFindings,
  collectNodeDenyCommandPatternFindings,
  collectSandboxDangerousConfigFindings,
  collectSandboxDockerNoopFindings,
  collectSecretsInConfigFindings,
  collectSmallModelRiskFindings,
  collectSyncedFolderFindings,
  type SecurityAuditFinding,
} from "./audit-extra.sync.js";

// Async collectors
export {
  collectSandboxBrowserHashLabelFindings,
  collectIncludeFilePermFindings,
  collectInstalledSkillsCodeSafetyFindings,
  collectPluginsCodeSafetyFindings,
  collectPluginsTrustFindings,
  collectStateDeepFilesystemFindings,
  readConfigSnapshotForAudit,
} from "./audit-extra.async.js";
