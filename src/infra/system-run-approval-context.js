import { normalizeSystemRunApprovalPlan } from "./system-run-approval-binding.js";
import { formatExecCommand, resolveSystemRunCommand } from "./system-run-command.js";
import { normalizeNonEmptyString, normalizeStringArray } from "./system-run-normalize.js";
function normalizeCommandText(value) {
    return typeof value === "string" ? value : "";
}
export function parsePreparedSystemRunPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return null;
    }
    const raw = payload;
    const cmdText = normalizeNonEmptyString(raw.cmdText);
    const plan = normalizeSystemRunApprovalPlan(raw.plan);
    if (!cmdText || !plan) {
        return null;
    }
    return { cmdText, plan };
}
export function resolveSystemRunApprovalRequestContext(params) {
    const host = normalizeNonEmptyString(params.host) ?? "";
    const plan = host === "node" ? normalizeSystemRunApprovalPlan(params.systemRunPlan) : null;
    const fallbackArgv = normalizeStringArray(params.commandArgv);
    const fallbackCommand = normalizeCommandText(params.command);
    return {
        plan,
        commandArgv: plan?.argv ?? (fallbackArgv.length > 0 ? fallbackArgv : undefined),
        commandText: plan ? (plan.rawCommand ?? formatExecCommand(plan.argv)) : fallbackCommand,
        cwd: plan?.cwd ?? normalizeNonEmptyString(params.cwd),
        agentId: plan?.agentId ?? normalizeNonEmptyString(params.agentId),
        sessionKey: plan?.sessionKey ?? normalizeNonEmptyString(params.sessionKey),
    };
}
export function resolveSystemRunApprovalRuntimeContext(params) {
    const normalizedPlan = normalizeSystemRunApprovalPlan(params.plan ?? null);
    if (normalizedPlan) {
        return {
            ok: true,
            plan: normalizedPlan,
            argv: [...normalizedPlan.argv],
            cwd: normalizedPlan.cwd,
            agentId: normalizedPlan.agentId,
            sessionKey: normalizedPlan.sessionKey,
            rawCommand: normalizedPlan.rawCommand,
        };
    }
    const command = resolveSystemRunCommand({
        command: params.command,
        rawCommand: params.rawCommand,
    });
    if (!command.ok) {
        return { ok: false, message: command.message, details: command.details };
    }
    return {
        ok: true,
        plan: null,
        argv: command.argv,
        cwd: normalizeNonEmptyString(params.cwd),
        agentId: normalizeNonEmptyString(params.agentId),
        sessionKey: normalizeNonEmptyString(params.sessionKey),
        rawCommand: normalizeNonEmptyString(params.rawCommand),
    };
}
