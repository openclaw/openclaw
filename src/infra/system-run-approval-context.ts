import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  AllowAlwaysPattern,
  ExecAsk,
  ExecSecurity,
  SystemRunApprovalPlan,
} from "./exec-approvals.js";
import { normalizeSystemRunApprovalPlan } from "./system-run-approval-plan.js";
import { formatExecCommand, resolveSystemRunCommandRequest } from "./system-run-command.js";
import { normalizeNonEmptyString, normalizeStringArray } from "./system-run-normalize.js";

// System-run approval context normalizes prepared node-run payloads and legacy
// command fields before they enter exec approval policy.
export type PreparedRunExecPolicy = {
  security: ExecSecurity;
  ask: ExecAsk;
};

type PreparedRunPayload = {
  plan: SystemRunApprovalPlan;
  execPolicy?: PreparedRunExecPolicy;
  allowAlwaysCoverage?: {
    complete: boolean;
    patterns: AllowAlwaysPattern[];
  };
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

type SystemRunApprovalRuntimeContext =
  | {
      ok: true;
      plan: SystemRunApprovalPlan | null;
      argv: string[];
      cwd: string | null;
      agentId: string | null;
      sessionKey: string | null;
      commandText: string;
    }
  | {
      ok: false;
      message: string;
      details?: Record<string, unknown>;
    };

function normalizeCommandText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeCommandPreview(
  value: string | null | undefined,
  authoritative: string,
): string | null {
  const preview = normalizeNonEmptyString(value);
  if (!preview || preview === authoritative) {
    return null;
  }
  return preview;
}

function normalizePreparedRunExecPolicy(raw: unknown): PreparedRunExecPolicy | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { security, ask } = raw;
  if (
    (security === "deny" || security === "allowlist" || security === "full") &&
    (ask === "off" || ask === "on-miss" || ask === "always")
  ) {
    return { security, ask };
  }
  return undefined;
}

function normalizeAllowAlwaysCoverage(raw: unknown): PreparedRunPayload["allowAlwaysCoverage"] {
  if (!isRecord(raw) || !Array.isArray(raw.patterns)) {
    return undefined;
  }
  const patterns = raw.patterns.flatMap((entry): AllowAlwaysPattern[] => {
    if (!isRecord(entry)) {
      return [];
    }
    const pattern = normalizeNonEmptyString(entry.pattern);
    if (!pattern) {
      return [];
    }
    const argPattern = normalizeNonEmptyString(entry.argPattern);
    return [{ pattern, ...(argPattern ? { argPattern } : {}) }];
  });
  return {
    complete: raw.complete === true,
    patterns,
  };
}

export function parsePreparedSystemRunPayload(raw: unknown): PreparedRunPayload | null {
  if (!isRecord(raw)) {
    return null;
  }
  const execPolicy = normalizePreparedRunExecPolicy(raw.execPolicy);
  const allowAlwaysCoverage = normalizeAllowAlwaysCoverage(raw.allowAlwaysCoverage);
  const plan = normalizeSystemRunApprovalPlan(raw.plan);
  if (plan) {
    return {
      plan,
      ...(execPolicy ? { execPolicy } : {}),
      ...(allowAlwaysCoverage ? { allowAlwaysCoverage } : {}),
    };
  }
  if (!isRecord(raw.plan)) {
    return null;
  }
  const legacyPlan = raw.plan;
  const argv = normalizeStringArray(legacyPlan.argv);
  const commandText =
    normalizeNonEmptyString(legacyPlan.rawCommand) ??
    normalizeNonEmptyString(raw.commandText) ??
    normalizeNonEmptyString(raw.cmdText);
  if (argv.length === 0 || !commandText) {
    return null;
  }
  return {
    plan: {
      argv,
      cwd: normalizeNonEmptyString(legacyPlan.cwd),
      commandText,
      commandPreview: normalizeNonEmptyString(legacyPlan.commandPreview),
      agentId: normalizeNonEmptyString(legacyPlan.agentId),
      sessionKey: normalizeNonEmptyString(legacyPlan.sessionKey),
    },
    ...(execPolicy ? { execPolicy } : {}),
    ...(allowAlwaysCoverage ? { allowAlwaysCoverage } : {}),
  };
}

/** Build the approval request context from tool payload fields. */
export function resolveSystemRunApprovalRequestContext(params: {
  host?: unknown;
  command?: unknown;
  commandArgv?: unknown;
  systemRunPlan?: unknown;
  cwd?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
}): SystemRunApprovalRequestContext {
  const host = normalizeNonEmptyString(params.host) ?? "";
  const normalizedPlan =
    host === "node" ? normalizeSystemRunApprovalPlan(params.systemRunPlan) : null;
  const fallbackArgv = normalizeStringArray(params.commandArgv);
  const fallbackCommand = normalizeCommandText(params.command);
  const commandText = normalizedPlan
    ? normalizedPlan.commandText || formatExecCommand(normalizedPlan.argv)
    : fallbackCommand;
  const commandPreview = normalizedPlan
    ? normalizeCommandPreview(normalizedPlan.commandPreview ?? fallbackCommand, commandText)
    : null;
  const plan = normalizedPlan ? { ...normalizedPlan, commandPreview } : null;
  return {
    plan,
    commandArgv: plan?.argv ?? (fallbackArgv.length > 0 ? fallbackArgv : undefined),
    commandText,
    commandPreview,
    cwd: plan?.cwd ?? normalizeNonEmptyString(params.cwd),
    agentId: plan?.agentId ?? normalizeNonEmptyString(params.agentId),
    sessionKey: plan?.sessionKey ?? normalizeNonEmptyString(params.sessionKey),
  };
}

/** Build the runtime approval context from already-normalized command inputs. */
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
      commandText: normalizedPlan.commandText,
    };
  }
  const command = resolveSystemRunCommandRequest({
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
    commandText: command.commandText,
  };
}
