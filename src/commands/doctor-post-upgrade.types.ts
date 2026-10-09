export type PostUpgradeFinding = {
  level: "ok" | "warn" | "error";
  code: string;
  message: string;
  plugin?: string;
  entry?: string;
};

export type PostUpgradeReport = {
  probesRun: string[];
  findings: PostUpgradeFinding[];
};

export const POST_UPGRADE_PROBE_CODES = [
  "plugin.index_unavailable",
  "plugin.entry_unresolved",
  "plugin.manifest_unavailable",
  "plugin.manifest_drift",
  "plugin.version_drift",
] as const;
