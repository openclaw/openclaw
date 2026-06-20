import type { GatewaySessionRow } from "../types.ts";

export type ControlDirectorDiagnosticsStatus =
  | "No diagnostics"
  | "Truth OK"
  | "Blocked unsupported claim"
  | "Judge approval missing"
  | "Liveness fallback"
  | "Mission blocked";

export type ControlDirectorDiagnosticsDetail = {
  label: string;
  value: string;
};

export type ControlDirectorDiagnosticsSummary = {
  status: ControlDirectorDiagnosticsStatus;
  tone: "ok" | "blocked" | "warn" | "muted";
  hasDiagnostics: boolean;
  title: string;
  detail: string;
  details: ControlDirectorDiagnosticsDetail[];
  blocked: boolean;
};

export const CONTROL_DIRECTOR_DIAGNOSTICS_EMPTY = "No Control Director diagnostics recorded";

function latestByTs<T extends { ts?: number }>(entries: readonly T[] | undefined): T | undefined {
  if (!entries || entries.length === 0) {
    return undefined;
  }
  return entries.toSorted((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0];
}

function latestLedger(
  entries: GatewaySessionRow["controlDirectorMissionLedger"],
): NonNullable<GatewaySessionRow["controlDirectorMissionLedger"]>[number] | undefined {
  if (!entries || entries.length === 0) {
    return undefined;
  }
  return entries.toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
}

function addDetail(
  details: ControlDirectorDiagnosticsDetail[],
  label: string,
  value: string | number | null | undefined,
) {
  if (value === null || value === undefined || value === "") {
    return;
  }
  details.push({ label, value: String(value) });
}

function firstMissing(value: readonly string[] | undefined): string | undefined {
  return value?.find((item) => item.trim().length > 0)?.trim();
}

function truthBlockedClaim(row: GatewaySessionRow) {
  const audit = latestByTs(row.controlDirectorTruthAudit);
  return audit?.claims.find(
    (claim) =>
      claim.matchStatus === "missing" || claim.rewriteAction === "blocked_unsupported_truth_claim",
  );
}

function judgeBlocked(row: GatewaySessionRow) {
  const ledger = latestLedger(row.controlDirectorMissionLedger);
  const gate = ledger?.judgeCompletionGate;
  if (gate?.status === "blocked") {
    return gate;
  }
  const guard = latestByTs(row.controlDirectorGuardAudit);
  if (
    guard?.action === "blocked_missing_judge_approval" ||
    guard?.action === "blocked_invalid_judge_approval"
  ) {
    return {
      reason: firstMissing(guard.missing) ?? guard.action,
      missing: guard.missing,
      status: "blocked" as const,
    };
  }
  return undefined;
}

function hasAnyDiagnostics(row: GatewaySessionRow): boolean {
  return Boolean(
    row.controlDirectorGuardAudit?.length ||
    row.controlDirectorLivenessAudit?.length ||
    row.controlDirectorMissionLedger?.length ||
    row.controlDirectorJudgeCompletionApproval ||
    row.controlDirectorTruthAudit?.length,
  );
}

export function summarizeControlDirectorDiagnostics(
  row: GatewaySessionRow | null | undefined,
): ControlDirectorDiagnosticsSummary {
  if (!row || !hasAnyDiagnostics(row)) {
    return {
      blocked: false,
      detail: CONTROL_DIRECTOR_DIAGNOSTICS_EMPTY,
      details: [],
      hasDiagnostics: false,
      status: "No diagnostics",
      title: "Truth & Completion",
      tone: "muted",
    };
  }

  const truthAudit = latestByTs(row.controlDirectorTruthAudit);
  const liveness = latestByTs(row.controlDirectorLivenessAudit);
  const guard = latestByTs(row.controlDirectorGuardAudit);
  const mission = latestLedger(row.controlDirectorMissionLedger);
  const approval = row.controlDirectorJudgeCompletionApproval ?? mission?.judgeCompletionApproval;
  const blockedTruthClaim = truthBlockedClaim(row);
  const blockedJudge = judgeBlocked(row);
  const details: ControlDirectorDiagnosticsDetail[] = [];

  addDetail(details, "Truth gate", truthAudit?.status);
  addDetail(details, "Claim", blockedTruthClaim?.claim ?? truthAudit?.claims[0]?.claim);
  addDetail(
    details,
    "Claim hash",
    blockedTruthClaim?.claimHash ?? truthAudit?.claims[0]?.claimHash,
  );
  addDetail(
    details,
    "Claim type",
    blockedTruthClaim?.claimType ?? truthAudit?.claims[0]?.claimType,
  );
  addDetail(
    details,
    "Required evidence",
    blockedTruthClaim?.requiredEvidenceType ?? truthAudit?.claims[0]?.requiredEvidenceType,
  );
  addDetail(
    details,
    "Missing evidence",
    blockedTruthClaim?.missingCondition ?? firstMissing(truthAudit?.missing),
  );
  addDetail(
    details,
    "Rewrite",
    blockedTruthClaim?.rewriteAction ?? truthAudit?.claims[0]?.rewriteAction,
  );
  addDetail(details, "Judge", mission?.judgeCompletionGate?.status ?? approval?.judgeStatus);
  addDetail(details, "Judge verdict", approval?.judgeVerdict);
  addDetail(details, "Liveness source", liveness?.source);
  addDetail(details, "Liveness reason", liveness?.reason);
  addDetail(details, "Mission", mission?.status);
  addDetail(
    details,
    "Completion Grade",
    mission?.completionGrade ? `${mission.completionGrade}/10` : undefined,
  );
  addDetail(details, "Criticality", mission?.criticality ? `${mission.criticality}/10` : undefined);
  addDetail(details, "Next build gap", mission?.nextBuildGap);
  addDetail(details, "Guard", guard?.action);
  addDetail(details, "Run", truthAudit?.runId ?? liveness?.runId ?? guard?.runId ?? mission?.runId);

  if (blockedTruthClaim) {
    return {
      blocked: true,
      detail: blockedTruthClaim.missingCondition ?? "Unsupported truth claim was blocked.",
      details,
      hasDiagnostics: true,
      status: "Blocked unsupported claim",
      title: "Truth & Completion",
      tone: "blocked",
    };
  }

  if (blockedJudge) {
    return {
      blocked: true,
      detail:
        blockedJudge.reason ??
        firstMissing(blockedJudge.missing) ??
        "Judge approval is missing or invalid.",
      details,
      hasDiagnostics: true,
      status: "Judge approval missing",
      title: "Truth & Completion",
      tone: "blocked",
    };
  }

  if (liveness?.action?.startsWith("synthesized_blocked")) {
    return {
      blocked: true,
      detail: liveness.reason,
      details,
      hasDiagnostics: true,
      status: "Liveness fallback",
      title: "Truth & Completion",
      tone: "warn",
    };
  }

  if (mission?.status === "blocked" || mission?.finalStatus === "blocked") {
    return {
      blocked: true,
      detail: mission.nextBuildGap ?? "Mission is blocked.",
      details,
      hasDiagnostics: true,
      status: "Mission blocked",
      title: "Truth & Completion",
      tone: "blocked",
    };
  }

  return {
    blocked: false,
    detail:
      truthAudit?.status === "passed" ? "Runtime truth checks passed." : "Diagnostics recorded.",
    details,
    hasDiagnostics: true,
    status: "Truth OK",
    title: "Truth & Completion",
    tone: "ok",
  };
}

export function countBlockedControlDirectorDiagnostics(rows: readonly GatewaySessionRow[]): number {
  return rows.filter((row) => summarizeControlDirectorDiagnostics(row).blocked).length;
}

export function latestControlDirectorDiagnosticsRows(
  rows: readonly GatewaySessionRow[],
  limit = 3,
): GatewaySessionRow[] {
  return rows
    .filter(hasAnyDiagnostics)
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, limit);
}
