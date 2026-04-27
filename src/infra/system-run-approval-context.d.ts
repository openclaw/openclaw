import type { SystemRunApprovalPlan } from "./exec-approvals.js";
type PreparedRunPayload = {
    plan: SystemRunApprovalPlan;
};
type SystemRunApprovalRequestContext = {
    plan: SystemRunApprovalPlan | null;
    commandArgv: string[] | undefined;
    commandText: string;
    commandPreview: string | null;
    cwd: string | null;
    agentId: string | null;
    sessionKey: string | null;
};
type SystemRunApprovalRuntimeContext = {
    ok: true;
    plan: SystemRunApprovalPlan | null;
    argv: string[];
    cwd: string | null;
    agentId: string | null;
    sessionKey: string | null;
    commandText: string;
} | {
    ok: false;
    message: string;
    details?: Record<string, unknown>;
};
export declare function parsePreparedSystemRunPayload(payload: unknown): PreparedRunPayload | null;
export declare function resolveSystemRunApprovalRequestContext(params: {
    host?: unknown;
    command?: unknown;
    commandArgv?: unknown;
    systemRunPlan?: unknown;
    cwd?: unknown;
    agentId?: unknown;
    sessionKey?: unknown;
}): SystemRunApprovalRequestContext;
export declare function resolveSystemRunApprovalRuntimeContext(params: {
    plan?: unknown;
    command?: unknown;
    rawCommand?: unknown;
    cwd?: unknown;
    agentId?: unknown;
    sessionKey?: unknown;
}): SystemRunApprovalRuntimeContext;
export {};
