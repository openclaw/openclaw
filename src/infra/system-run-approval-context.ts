import type { SystemRunApprovalPlanV2 } from "./exec-approvals.js";
import { normalizeSystemRunApprovalPlanV2 } from "./system-run-approval-binding.js";
import { formatExecCommand, resolveSystemRunCommand } from "./system-run-command.js";

type PreparedRunPayload = {
  cmdText: string;
  plan: SystemRunApprovalPlanV2;
};

type SystemRunApprovalRequestContext = {
  planV2: SystemRunApprovalPlanV2 | null;
  commandArgv: string[] | undefined;
  commandText: string;
  cwd: string | null;
  agentId: string | null;
  sessionKey: string | null;
};

type SystemRunApprovalRuntimeContext =
  | {
      ok: true;
      planV2: SystemRunApprovalPlanV2 | null;
      argv: string[];
      cwd: string | null;
      agentId: string | null;
      sessionKey: string | null;
      rawCommand: string | null;
    }
  | {
      ok: false;
      message: string;
      details?: Record<string, unknown>;
    };

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function normalizeCommandText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parsePreparedSystemRunPayload(payload: unknown): PreparedRunPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const raw = payload as { cmdText?: unknown; plan?: unknown };
  const cmdText = normalizeString(raw.cmdText);
  const plan = normalizeSystemRunApprovalPlanV2(raw.plan);
  if (!cmdText || !plan) {
    return null;
  }
  return { cmdText, plan };
}

export function resolveSystemRunApprovalRequestContext(params: {
  host?: unknown;
  command?: unknown;
  commandArgv?: unknown;
  systemRunPlanV2?: unknown;
  cwd?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
}): SystemRunApprovalRequestContext {
  const host = normalizeString(params.host) ?? "";
  const planV2 = host === "node" ? normalizeSystemRunApprovalPlanV2(params.systemRunPlanV2) : null;
  const fallbackArgv = normalizeStringArray(params.commandArgv);
  const fallbackCommand = normalizeCommandText(params.command);
  return {
    planV2,
    commandArgv: planV2?.argv ?? (fallbackArgv.length > 0 ? fallbackArgv : undefined),
    commandText: planV2 ? (planV2.rawCommand ?? formatExecCommand(planV2.argv)) : fallbackCommand,
    cwd: planV2?.cwd ?? normalizeString(params.cwd),
    agentId: planV2?.agentId ?? normalizeString(params.agentId),
    sessionKey: planV2?.sessionKey ?? normalizeString(params.sessionKey),
  };
}

export function resolveSystemRunApprovalRuntimeContext(params: {
  planV2?: unknown;
  command?: unknown;
  rawCommand?: unknown;
  cwd?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
}): SystemRunApprovalRuntimeContext {
  const normalizedPlan = normalizeSystemRunApprovalPlanV2(params.planV2 ?? null);
  if (normalizedPlan) {
    return {
      ok: true,
      planV2: normalizedPlan,
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
    planV2: null,
    argv: command.argv,
    cwd: normalizeString(params.cwd),
    agentId: normalizeString(params.agentId),
    sessionKey: normalizeString(params.sessionKey),
    rawCommand: normalizeString(params.rawCommand),
  };
}
