import type { SystemRunApprovalPlan } from "./exec-approvals.js";
import { normalizeSystemRunApprovalPlan } from "./system-run-approval-binding.js";
import { formatExecCommand, resolveSystemRunCommand } from "./system-run-command.js";

type PreparedRunPayload = {
  cmdText: string;
  plan: SystemRunApprovalPlan;
};

type SystemRunApprovalRequestContext = {
  plan: SystemRunApprovalPlan | null;
  commandArgv: string[] | undefined;
  commandText: string;
  cwd: string | null;
  agentId: string | null;
  sessionKey: string | null;
};

type SystemRunApprovalRuntimeContext =
  | {
      ok: true;
      plan: SystemRunApprovalPlan | null;
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
  const plan = normalizeSystemRunApprovalPlan(raw.plan);
  if (!cmdText || !plan) {
    return null;
  }
  return { cmdText, plan };
}

export function resolveSystemRunApprovalRequestContext(params: {
  host?: unknown;
  command?: unknown;
  commandArgv?: unknown;
  systemRunPlan?: unknown;
  cwd?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
}): SystemRunApprovalRequestContext {
  const host = normalizeString(params.host) ?? "";
  const plan = host === "node" ? normalizeSystemRunApprovalPlan(params.systemRunPlan) : null;
  const fallbackArgv = normalizeStringArray(params.commandArgv);
  const fallbackCommand = normalizeCommandText(params.command);
  return {
    plan,
    commandArgv: plan?.argv ?? (fallbackArgv.length > 0 ? fallbackArgv : undefined),
    commandText: plan ? (plan.rawCommand ?? formatExecCommand(plan.argv)) : fallbackCommand,
    cwd: plan?.cwd ?? normalizeString(params.cwd),
    agentId: plan?.agentId ?? normalizeString(params.agentId),
    sessionKey: plan?.sessionKey ?? normalizeString(params.sessionKey),
  };
}

export function resolveSystemRunApprovalRuntimeContext(params: {
  plan?: unknown;
  command?: unknown;
  rawCommand?: unknown;
  cwd?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
}): SystemRunApprovalRuntimeContext {
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
    cwd: normalizeString(params.cwd),
    agentId: normalizeString(params.agentId),
    sessionKey: normalizeString(params.sessionKey),
    rawCommand: normalizeString(params.rawCommand),
  };
}
