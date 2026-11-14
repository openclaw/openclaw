import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isWellFormedApprovalId,
  type ApprovalKind,
} from "../../packages/gateway-protocol/src/index.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import type { ExecApprovalsCliOpts } from "./exec-approvals-snapshot.js";
import { callGatewayFromCli } from "./gateway-rpc.js";

export type PendingApprovalCliEntry = NonNullable<ReturnType<typeof readPendingApprovalEntry>>;

function readPendingApprovalEntry(value: unknown, kind: ApprovalKind) {
  if (!isRecord(value) || !isRecord(value.request)) {
    return null;
  }
  // Approval ids are opaque and stored verbatim by the gateway — never trim
  // them, or two ids differing only in whitespace collapse into one display
  // form and resolving could target the wrong request. Whitespace-bearing ids
  // fail the terminal-safe charset and render as exact-round-trip id64 tokens.
  // Ill-formed (lone-surrogate) ids are skipped outright: the unified
  // approval.get/resolve schema rejects them, so listing one would advertise
  // a token that can never be resolved.
  const id = typeof value.id === "string" && isWellFormedApprovalId(value.id) ? value.id : null;
  const createdAtMs = value.createdAtMs;
  const expiresAtMs = value.expiresAtMs;
  if (
    !id ||
    typeof createdAtMs !== "number" ||
    !Number.isFinite(createdAtMs) ||
    typeof expiresAtMs !== "number" ||
    !Number.isFinite(expiresAtMs)
  ) {
    return null;
  }
  const request = value.request;
  const agentId = normalizeOptionalString(request.agentId) ?? null;
  const sessionKey = normalizeOptionalString(request.sessionKey) ?? null;
  const command = typeof request.command === "string" && request.command ? request.command : null;
  const title = typeof request.title === "string" && request.title ? request.title : null;
  const description =
    typeof request.description === "string" && request.description ? request.description : null;
  const prose = title && description ? `${title}: ${description}` : (title ?? description);
  // System-agent approvals stay on their reviewer-safe presentation (title,
  // description); the raw operation is host-local by contract and must not
  // leak into terminals, scripts, or logs.
  const summarySource =
    kind === "exec"
      ? command
      : kind === "plugin" && command
        ? `${prose ? `${prose} — ` : ""}Command: ${command}`
        : prose;
  return {
    id,
    kind,
    agentId,
    sessionKey,
    createdAtMs,
    expiresAtMs,
    summary: summarySource ?? "(summary unavailable)",
  };
}

function readPendingApprovalList(value: unknown, kind: ApprovalKind): PendingApprovalCliEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${kind} approval list response.`);
  }
  return value.flatMap((entry) => {
    const parsed = readPendingApprovalEntry(entry, kind);
    return parsed ? [parsed] : [];
  });
}

export async function loadPendingApprovals(
  opts: ExecApprovalsCliOpts,
  signal?: AbortSignal,
): Promise<PendingApprovalCliEntry[]> {
  // The owner-specific list methods retain requester filtering unless the caller is an admin.
  // Request admin explicitly so this operator command cannot silently omit live approvals.
  const listCall = (method: string) =>
    callGatewayFromCli(method, opts, {}, { scopes: [ADMIN_SCOPE], ...(signal ? { signal } : {}) });
  const [exec, plugin, systemAgent] = await Promise.all([
    listCall("exec.approval.list"),
    listCall("plugin.approval.list"),
    listCall("openclaw.approval.list"),
  ]);
  return [
    ...readPendingApprovalList(exec, "exec"),
    ...readPendingApprovalList(plugin, "plugin"),
    ...readPendingApprovalList(systemAgent, "system-agent"),
  ].toSorted((a, b) => b.createdAtMs - a.createdAtMs);
}
