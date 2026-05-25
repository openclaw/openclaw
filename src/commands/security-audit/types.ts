export type SecuritySeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type SecurityFinding = {
  id: string;
  severity: SecuritySeverity;
  category: "credential" | "permission" | "network" | "config";
  message: string;
  file?: string;
  line?: number;
  remediation?: string;
};

export type SecurityAuditResult = {
  findings: SecurityFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
  scannedPaths: string[];
};

export type SecurityAuditOptions = {
  json?: boolean;
  severityMin?: SecuritySeverity;
  includeCredentials?: boolean;
  includePermissions?: boolean;
  includeNetwork?: boolean;
  includeConfig?: boolean;
};
