import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  AllowAlwaysPattern,
  ExecAsk,
  ExecSecurity,
  SystemRunApprovalPlan,
} from "./exec-approvals.js";
import { normalizeSystemRunApprovalPlan } from "./system-run-approval-plan.js";
import { resolveSystemRunCommandRequest } from "./system-run-command.js";
import { normalizeNonEmptyString, normalizeStringArray } from "./system-run-normalize.js";

// System-run approval context normalizes prepared node-run payloads before exec policy.
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
  if (!plan) {
    return null;
  }
  return {
    plan,
    ...(execPolicy ? { execPolicy } : {}),
    ...(allowAlwaysCoverage ? { allowAlwaysCoverage } : {}),
  };
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
  const host = normalizeNonEmptyString(params.host) ?? "";
  const normalizedPlan =
    host === "node" ? normalizeSystemRunApprovalPlan(params.systemRunPlan) : null;
  const fallbackArgv = normalizeStringArray(params.commandArgv);
  const fallbackCommand = typeof params.command === "string" ? params.command : "";
  const commandText = normalizedPlan?.commandText ?? fallbackCommand;
  const preview = normalizedPlan
    ? (normalizedPlan.commandPreview ?? normalizeNonEmptyString(fallbackCommand))
    : null;
  const commandPreview = preview && preview !== commandText ? preview : null;
  const cwd = normalizedPlan?.cwd ?? normalizeNonEmptyString(params.cwd);
  const agentId = normalizedPlan?.agentId ?? normalizeNonEmptyString(params.agentId);
  const sessionKey = normalizedPlan?.sessionKey ?? normalizeNonEmptyString(params.sessionKey);
  const plan = normalizedPlan
    ? { ...normalizedPlan, commandPreview, cwd, agentId, sessionKey }
    : null;
  return {
    plan,
    commandArgv: plan?.argv ?? (fallbackArgv.length > 0 ? fallbackArgv : undefined),
    commandText,
    commandPreview,
    cwd,
    agentId,
    sessionKey,
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
    const sessionKey = normalizedPlan.sessionKey ?? normalizeNonEmptyString(params.sessionKey);
    // The forwarded plan must carry the same identity as the outer context:
    // the node rejects approvals whose plan session key does not match it.
    const plan =
      sessionKey && sessionKey !== normalizedPlan.sessionKey
        ? { ...normalizedPlan, sessionKey }
        : normalizedPlan;
    return {
      ok: true,
      plan,
      argv: [...plan.argv],
      cwd: plan.cwd,
      agentId: plan.agentId,
      sessionKey,
      commandText: plan.commandText,
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
