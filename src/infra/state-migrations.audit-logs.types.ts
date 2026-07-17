export type LegacyAuditLogSource = {
  kind: "config" | "system-agent" | "crestodian";
  label: string;
  sourcePath: string;
};

export type LegacyAuditLogsDetection = {
  sources: LegacyAuditLogSource[];
  hasLegacy: boolean;
};
