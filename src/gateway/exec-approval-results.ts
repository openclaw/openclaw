import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import type {
  ExecApprovalForceDenyResult,
  ExecApprovalManagerOptions,
  ExecApprovalRecord,
  ExecApprovalResolutionSource,
  ExecApprovalResolveResult,
} from "./exec-approval-manager.types.js";
import type { OperatorApprovalKind, OperatorApprovalRecord } from "./operator-approval-store.js";

export function prepareExecApprovalStandingGrant<TPayload>(params: {
  decision: ExecApprovalDecision;
  record: ExecApprovalRecord<TPayload> | undefined;
  options: Pick<
    ExecApprovalManagerOptions<TPayload>,
    "resolveStandingGrantMint" | "resolveStandingGrantExpiresAtMs"
  >;
  grantExpiresAtMs: number | null | undefined;
}) {
  let standingGrantSpec =
    params.decision === "allow-always" && params.record
      ? (params.options.resolveStandingGrantMint?.(params.record.request) ?? undefined)
      : undefined;
  if (standingGrantSpec?.kind === "mcp-tool" && params.record?.mcpToolApprovalActive?.() !== true) {
    standingGrantSpec = undefined;
  }
  const standingGrant = standingGrantSpec
    ? {
        ...standingGrantSpec,
        expiresAtMs:
          params.grantExpiresAtMs !== undefined
            ? params.grantExpiresAtMs
            : (params.options.resolveStandingGrantExpiresAtMs?.(Date.now()) ?? null),
      }
    : undefined;
  return { standingGrantSpec, standingGrant };
}

export function prepareExecApprovalStorageFailure(recordId: string, nowMs: number) {
  return {
    recordId,
    decision: "deny",
    resolvedAtMs: nowMs,
    resolvedBy: "storage-error",
    resolverKind: "system",
    status: "denied",
    terminalReason: "storage-corrupt",
    retainForManagerLifetime: true,
  } as const;
}

export function projectClosedApprovalResolution<TPayload>(
  closed: ExecApprovalForceDenyResult<TPayload>,
): ExecApprovalResolveResult<TPayload> {
  if (closed.outcome === "not-found" || closed.outcome === "corrupt") {
    return closed;
  }
  return {
    outcome: "already-resolved",
    retry: "conflict",
    record: closed.record,
    ...(closed.liveRecord ? { liveRecord: closed.liveRecord } : {}),
  };
}

export function projectRepairedApprovalResolution<TPayload>(
  repaired: ExecApprovalForceDenyResult<TPayload>,
  decision: ExecApprovalDecision,
): ExecApprovalResolveResult<TPayload> {
  if (
    repaired.outcome === "expired" ||
    repaired.outcome === "not-found" ||
    repaired.outcome === "corrupt"
  ) {
    return repaired;
  }
  if (repaired.outcome === "denied" && decision === "deny") {
    return {
      outcome: "resolved",
      record: repaired.record,
      ...(repaired.liveRecord ? { liveRecord: repaired.liveRecord } : {}),
    };
  }
  return {
    outcome: "already-resolved",
    retry: repaired.record.decision === decision ? "same" : "conflict",
    record: repaired.record,
    ...(repaired.liveRecord ? { liveRecord: repaired.liveRecord } : {}),
  };
}

export function prepareExecApprovalSettlement(params: {
  record: OperatorApprovalRecord;
  expectedKind: OperatorApprovalKind;
  runtimeEpoch: string;
  localDecision: ExecApprovalDecision | null | undefined;
  localResolvedBy: string | null;
  localResolutionSource: ExecApprovalResolutionSource;
}) {
  const { record } = params;
  if (
    record.kind !== params.expectedKind ||
    record.runtimeEpoch !== params.runtimeEpoch ||
    record.status === "pending" ||
    record.resolvedAtMs === null
  ) {
    return null;
  }
  // No delivery route is unanswered, even though storage records a fail-closed deny.
  const answered =
    record.status === "allowed" ||
    (record.status === "denied" && record.terminalReason !== "no-route");
  const decision =
    params.localDecision === undefined ? (answered ? record.decision : null) : params.localDecision;
  return {
    recordId: record.id,
    decision,
    resolvedAtMs: record.resolvedAtMs,
    resolvedBy: params.localResolvedBy,
    resolverKind: record.resolver?.kind ?? null,
    status: record.status,
    terminalReason: record.terminalReason,
    consumedAtMs: record.consumedAtMs,
    consumedBy: record.consumedBy,
    resolutionSource: params.localResolutionSource,
  };
}
