import { resolveSystemRunCommand } from "../infra/system-run-command.js";
import type { ExecApprovalRecord } from "./exec-approval-manager.js";

type SystemRunParamsLike = {
  command?: unknown;
  rawCommand?: unknown;
  cwd?: unknown;
  env?: unknown;
  timeoutMs?: unknown;
  needsScreenRecording?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
  approved?: unknown;
  approvalDecision?: unknown;
  runId?: unknown;
};

type ApprovalLookup = {
  getSnapshot: (recordId: string) => ExecApprovalRecord | null;
};

type ApprovalClient = {
  connId?: string | null;
  connect?: {
    scopes?: unknown;
    device?: { id?: string | null } | null;
  } | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeApprovalDecision(value: unknown): "allow-once" | "allow-always" | null {
  const s = normalizeString(value);
  return s === "allow-once" || s === "allow-always" ? s : null;
}

function clientHasApprovals(client: ApprovalClient | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client?.connect?.scopes : [];
  return scopes.includes("operator.admin") || scopes.includes("operator.approvals");
}

function approvalMatchesRequest(
  cmdText: string,
  params: SystemRunParamsLike,
  record: ExecApprovalRecord,
): boolean {
  if (record.request.host !== "node") {
    return false;
  }

  if (!cmdText || record.request.command !== cmdText) {
    return false;
  }

  const reqCwd = record.request.cwd ?? null;
  const runCwd = normalizeString(params.cwd) ?? null;
  if (reqCwd !== runCwd) {
    return false;
  }

  const reqAgentId = record.request.agentId ?? null;
  const runAgentId = normalizeString(params.agentId) ?? null;
  if (reqAgentId !== runAgentId) {
    return false;
  }

  const reqSessionKey = record.request.sessionKey ?? null;
  const runSessionKey = normalizeString(params.sessionKey) ?? null;
  if (reqSessionKey !== runSessionKey) {
    return false;
  }

  return true;
}

function pickSystemRunParams(raw: Record<string, unknown>): Record<string, unknown> {
  // Defensive allowlist: only forward fields that the node-host `system.run` handler understands.
  // This prevents future internal control fields from being smuggled through the gateway.
  const next: Record<string, unknown> = {};
  for (const key of [
    "command",
    "rawCommand",
    "cwd",
    "env",
    "timeoutMs",
    "needsScreenRecording",
    "agentId",
    "sessionKey",
    "runId",
  ]) {
    if (key in raw) {
      next[key] = raw[key];
    }
  }
  return next;
}

/**
 * Gate `system.run` approval flags (`approved`, `approvalDecision`) behind a real
 * `exec.approval.*` record. This prevents users with only `operator.write` from
 * bypassing node-host approvals by injecting control fields into `node.invoke`.
 */
export function sanitizeSystemRunParamsForForwarding(opts: {
  nodeId?: string | null;
  rawParams: unknown;
  client: ApprovalClient | null;
  execApprovalManager?: ApprovalLookup;
  nowMs?: number;
}):
  | { ok: true; params: unknown }
  | { ok: false; message: string; details?: Record<string, unknown> } {
  const obj = asRecord(opts.rawParams);
  if (!obj) {
    return { ok: true, params: opts.rawParams };
  }

  const p = obj as SystemRunParamsLike;
  const cmdTextResolution = resolveSystemRunCommand({
    command: p.command,
    rawCommand: p.rawCommand,
  });
  if (!cmdTextResolution.ok) {
    return {
      ok: false,
      message: cmdTextResolution.message,
      details: cmdTextResolution.details,
    };
  }
  const cmdText = cmdTextResolution.cmdText;

  const approved = p.approved === true;
  const requestedDecision = normalizeApprovalDecision(p.approvalDecision);
  const wantsApprovalOverride = approved || requestedDecision !== null;

  // Always strip control fields from user input. If the override is allowed,
  // we re-add trusted fields based on the gateway approval record.
  const next: Record<string, unknown> = pickSystemRunParams(obj);

  if (!wantsApprovalOverride) {
    return { ok: true, params: next };
  }

  const runId = normalizeString(p.runId);
  if (!runId) {
    return {
      ok: false,
      message: "approval override requires params.runId",
      details: { code: "MISSING_RUN_ID" },
    };
  }

  const manager = opts.execApprovalManager;
  if (!manager) {
    return {
      ok: false,
      message: "exec approvals unavailable",
      details: { code: "APPROVALS_UNAVAILABLE" },
    };
  }

  const snapshot = manager.getSnapshot(runId);
  if (!snapshot) {
    return {
      ok: false,
      message: "unknown or expired approval id",
      details: { code: "UNKNOWN_APPROVAL_ID", runId },
    };
  }

  const nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now();
  if (nowMs > snapshot.expiresAtMs) {
    return {
      ok: false,
      message: "approval expired",
      details: { code: "APPROVAL_EXPIRED", runId },
    };
  }

  const targetNodeId = normalizeString(opts.nodeId);
  if (!targetNodeId) {
    return {
      ok: false,
      message: "node.invoke requires nodeId",
      details: { code: "MISSING_NODE_ID", runId },
    };
  }
  const approvalNodeId = normalizeString(snapshot.request.nodeId);
  if (!approvalNodeId) {
    return {
      ok: false,
      message: "approval id missing node binding",
      details: { code: "APPROVAL_NODE_BINDING_MISSING", runId },
    };
  }
  if (approvalNodeId !== targetNodeId) {
    return {
      ok: false,
      message: "approval id not valid for this node",
      details: { code: "APPROVAL_NODE_MISMATCH", runId },
    };
  }

  // Prefer binding by device identity (stable across reconnects / per-call clients like callGateway()).
  // Fallback to connId only when device identity is not available.
  const snapshotDeviceId = snapshot.requestedByDeviceId ?? null;
  const clientDeviceId = opts.client?.connect?.device?.id ?? null;
  if (snapshotDeviceId) {
    if (snapshotDeviceId !== clientDeviceId) {
      return {
        ok: false,
        message: "approval id not valid for this device",
        details: { code: "APPROVAL_DEVICE_MISMATCH", runId },
      };
    }
  } else if (
    snapshot.requestedByConnId &&
    snapshot.requestedByConnId !== (opts.client?.connId ?? null)
  ) {
    return {
      ok: false,
      message: "approval id not valid for this client",
      details: { code: "APPROVAL_CLIENT_MISMATCH", runId },
    };
  }

  if (!approvalMatchesRequest(cmdText, p, snapshot)) {
    return {
      ok: false,
      message: "approval id does not match request",
      details: { code: "APPROVAL_REQUEST_MISMATCH", runId },
    };
  }

  // Normal path: enforce the decision recorded by the gateway.
  if (snapshot.decision === "allow-once" || snapshot.decision === "allow-always") {
    next.approved = true;
    next.approvalDecision = snapshot.decision;
    return { ok: true, params: next };
  }

  // If the approval request timed out (decision=null), allow askFallback-driven
  // "allow-once" ONLY for clients that are allowed to use exec approvals.
  const timedOut =
    snapshot.resolvedAtMs !== undefined &&
    snapshot.decision === undefined &&
    snapshot.resolvedBy === null;
  if (
    timedOut &&
    approved &&
    requestedDecision === "allow-once" &&
    clientHasApprovals(opts.client)
  ) {
    next.approved = true;
    next.approvalDecision = "allow-once";
    return { ok: true, params: next };
  }

  return {
    ok: false,
    message: "approval required",
    details: { code: "APPROVAL_REQUIRED", runId },
  };
}
