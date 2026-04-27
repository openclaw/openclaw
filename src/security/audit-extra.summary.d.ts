import type { OpenClawConfig } from "../config/types.openclaw.js";
export type SecurityAuditFinding = {
    checkId: string;
    severity: "info" | "warn" | "critical";
    title: string;
    detail: string;
    remediation?: string;
};
export declare function collectAttackSurfaceSummaryFindings(cfg: OpenClawConfig): SecurityAuditFinding[];
export declare function collectSmallModelRiskFindings(params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
}): SecurityAuditFinding[];
