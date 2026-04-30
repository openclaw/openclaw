export type PolicyActionType =
  | "file_write"
  | "shell_exec"
  | "git_mutation"
  | "message_send"
  | "external_api_write"
  | "status_transition"
  | "completion_claim";

export type PolicyDecision = "allow" | "block" | "requireApproval";
export type PolicyMode = "shadow" | "enforce" | "disabled";

export type PolicyReasonCode =
  | "allowed"
  | "policy_disabled"
  | "shadow_allowed"
  | "protected_worktree"
  | "unassigned_worktree"
  | "audit_failed"
  | "approval_required"
  | "missing_evidence"
  | "stale_evidence"
  | "external_write"
  | "shell_risk"
  | "invalid_request";

export type PolicyActor = {
  id?: string;
  sessionKey?: string;
  sessionId?: string;
  role?: string;
};

export type PolicyRequest = {
  policyVersion: string;
  actor?: PolicyActor;
  actionType: PolicyActionType;
  toolName?: string;
  targetResource?: string;
  payloadSummary?: unknown;
  context?: Record<string, unknown>;
  correlationId?: string;
};

export type PolicyResult = {
  decision: PolicyDecision;
  policyId: string;
  reasonCode: PolicyReasonCode;
  reason: string;
  mode?: PolicyMode;
  correlationId?: string;
  payloadSummary?: unknown;
};

export type PolicyModule = {
  id: string;
  evaluate: (request: PolicyRequest, config: PolicyKernelConfig) => PolicyResult | undefined | null;
};

export type PolicyKernelConfig = {
  defaultMode?: PolicyMode;
  moduleModes?: Record<string, PolicyMode>;
};

const SECRET_KEY_RE = /(token|secret|password|passwd|api[_-]?key|authorization|credential|cookie)/i;
const MAX_STRING_LENGTH = 160;
const MAX_ARRAY_LENGTH = 8;
const MAX_OBJECT_KEYS = 16;
const MAX_DEPTH = 4;

function truncateString(value: string): string {
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
    : value;
}

function summarizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    return "[max-depth]";
  }
  if (value == null) {
    return value;
  }
  if (typeof value === "string") {
    return truncateString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((item) => summarizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)
      .toSorted()
      .slice(0, MAX_OBJECT_KEYS)) {
      out[key] = SECRET_KEY_RE.test(key)
        ? "[redacted]"
        : summarizeValue((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  return `[${typeof value}]`;
}

export function summarizePolicyPayload(value: unknown): unknown {
  return summarizeValue(value, 0);
}

export function policyResult(
  params: Omit<PolicyResult, "policyId"> & { policyId?: string },
): PolicyResult {
  return {
    policyId: params.policyId ?? "action-sink-policy",
    decision: params.decision,
    reasonCode: params.reasonCode,
    reason: params.reason,
    mode: params.mode,
    correlationId: params.correlationId,
    payloadSummary: params.payloadSummary,
  };
}

function applyMode(result: PolicyResult, mode: PolicyMode): PolicyResult {
  if (mode === "disabled") {
    return policyResult({
      policyId: result.policyId,
      decision: "allow",
      reasonCode: "policy_disabled",
      reason: `Policy ${result.policyId} disabled`,
      mode,
      correlationId: result.correlationId,
      payloadSummary: result.payloadSummary,
    });
  }
  if (mode === "shadow" && result.decision !== "allow") {
    return policyResult({
      policyId: result.policyId,
      decision: "allow",
      reasonCode: "shadow_allowed",
      reason: `Shadow mode would have ${result.decision}: ${result.reason}`,
      mode,
      correlationId: result.correlationId,
      payloadSummary: result.payloadSummary,
    });
  }
  return { ...result, mode };
}

export function evaluateActionSinkPolicy(
  request: PolicyRequest,
  config: PolicyKernelConfig = {},
  modules: PolicyModule[] = [],
): PolicyResult {
  const defaultMode = config.defaultMode ?? "enforce";
  for (const module of modules) {
    const mode = config.moduleModes?.[module.id] ?? defaultMode;
    if (mode === "disabled") {
      continue;
    }
    const result = module.evaluate(request, config);
    if (!result || result.decision === "allow") {
      continue;
    }
    return applyMode(
      { ...result, correlationId: result.correlationId ?? request.correlationId },
      mode,
    );
  }
  return policyResult({
    decision: "allow",
    reasonCode: defaultMode === "disabled" ? "policy_disabled" : "allowed",
    reason: defaultMode === "disabled" ? "Policy disabled" : "No policy module blocked the action",
    mode: defaultMode,
    correlationId: request.correlationId,
    payloadSummary: summarizePolicyPayload(request.payloadSummary),
  });
}
