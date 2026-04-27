import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ExecApprovalDecision, type ExecApprovalsFile, type ExecAsk, type ExecSecurity, type ExecTarget } from "./exec-approvals.js";
type ExecPolicyConfig = {
    host?: ExecTarget;
    security?: ExecSecurity;
    ask?: ExecAsk;
};
export type ExecPolicyHostSummary = {
    requested: ExecTarget;
    requestedSource: string;
};
export type ExecPolicyFieldSummary<TValue extends ExecSecurity | ExecAsk> = {
    requested: TValue;
    requestedSource: string;
    host: TValue;
    hostSource: string;
    effective: TValue;
    note: string;
};
export type ExecPolicyScopeSnapshot = {
    scopeLabel: string;
    configPath: string;
    agentId?: string;
    host: ExecPolicyHostSummary;
    security: ExecPolicyFieldSummary<ExecSecurity>;
    ask: ExecPolicyFieldSummary<ExecAsk>;
    askFallback: {
        effective: ExecSecurity;
        source: string;
    };
    allowedDecisions: readonly ExecApprovalDecision[];
};
export type ExecPolicyScopeSummary = Omit<ExecPolicyScopeSnapshot, "allowedDecisions">;
export declare function collectExecPolicyScopeSnapshots(params: {
    cfg: OpenClawConfig;
    approvals: ExecApprovalsFile;
    hostPath?: string;
}): ExecPolicyScopeSnapshot[];
export declare function resolveExecPolicyScopeSummary(params: {
    approvals: ExecApprovalsFile;
    scopeExecConfig?: ExecPolicyConfig | undefined;
    globalExecConfig?: ExecPolicyConfig | undefined;
    configPath: string;
    scopeLabel: string;
    agentId?: string;
    hostPath?: string;
}): ExecPolicyScopeSummary;
export declare function resolveExecPolicyScopeSnapshot(params: {
    approvals: ExecApprovalsFile;
    scopeExecConfig?: ExecPolicyConfig | undefined;
    globalExecConfig?: ExecPolicyConfig | undefined;
    configPath: string;
    scopeLabel: string;
    agentId?: string;
    hostPath?: string;
}): ExecPolicyScopeSnapshot;
export {};
