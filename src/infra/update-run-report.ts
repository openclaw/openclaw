import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isVerifiedUpdateRollback } from "../shared/update-outcome.js";
import type { RestartSentinelPayload } from "./restart-sentinel-store.js";
import { resolveUpdateRunVerifiedServingVersion } from "./update-run-notice.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import type { UpdateRunReportHealth } from "./update-run-report-health.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import type { UpdateRunResult } from "./update-runner-types.js";

export type UpdateRunReportInput = Pick<
  UpdateRunRecord,
  | "status"
  | "phase"
  | "reason"
  | "origin"
  | "before"
  | "after"
  | "steps"
  | "verification"
  | "repair"
  | "downtimeMs"
> &
  Partial<Pick<UpdateRunRecord, "target" | "createdAtMs" | "finishedAtMs">>;

type UpdateRunIdentity =
  | { kind: "unobserved" }
  | { kind: "verified" }
  | { kind: "unavailable" }
  | { kind: "mismatch"; field: "version" | "build" };

export function resolveUpdateRunIdentity(
  facts: UpdateRunRecord["verification"],
  expected: UpdateRunRecord["after"],
): UpdateRunIdentity {
  if (facts.versionMatch === undefined) {
    return { kind: "unobserved" };
  }
  if (facts.versionMatch) {
    return { kind: "verified" };
  }
  if (facts.runningVersion && expected.version && facts.runningVersion !== expected.version) {
    return { kind: "mismatch", field: "version" };
  }
  if (facts.runningBuildId && expected.buildId && facts.runningBuildId !== expected.buildId) {
    return { kind: "mismatch", field: "build" };
  }
  // Published drivers stored false for missing identity as well as disagreement.
  return { kind: "unavailable" };
}

export function formatUpdateRunIdentity(
  facts: UpdateRunRecord["verification"],
  expected: UpdateRunRecord["after"],
): string | null {
  const identity = resolveUpdateRunIdentity(facts, expected);
  if (identity.kind === "mismatch") {
    return `${identity.field} mismatch`;
  }
  return {
    unobserved: null,
    verified: "version verified",
    unavailable: "service identity unavailable",
  }[identity.kind];
}

export function formatUpdateRunCurrentHealth(health: UpdateRunReportHealth): string {
  return health.kind === "responding"
    ? `Current health: Gateway answered on the recorded port (${bounded(health.version, 120)}).`
    : "Current health unavailable; saved verification describes the update attempt only.";
}

/** Public-report callers redact identifiers before using this shared formatter. */
export function formatUpdateRunRecovery(
  verification: UpdateRunRecord["verification"],
  observation: Pick<UpdateRunRecord["steps"][number], "failureFacts" | "exitCode"> | undefined,
  reason = verification.recovery?.reason ?? "not-recorded",
): string | undefined {
  const { recovery } = verification;
  if (!observation) {
    if (!recovery) {
      return undefined;
    }
    const restored = recovery.packageRollbackVerified;
    if (!recovery.serviceRestartSafe) {
      return `${restored ? "package rollback verified; service restart not verified" : "not verified"} (${reason})`;
    }
    const version = bounded(recovery.version, 120);
    if (recovery.service === "healthy") {
      return `${restored ? "package rollback verified; " : ""}Gateway serving ${version}; health verified`;
    }
    if (recovery.service !== "failed" && !restored) {
      return "verified safe to restart";
    }
    const packageOutcome = restored
      ? `package rollback verified (${version})`
      : "runtime files verified";
    return `${packageOutcome}; Gateway health ${recovery.service === "failed" ? "failed" : "unverified"} (${reason}). Run \`openclaw gateway status --deep\` to check the serving version and readiness.`;
  }
  const version = resolveUpdateRunVerifiedServingVersion(verification, observation);
  if (version) {
    const constraint =
      recovery?.serviceRestartSafe === false ? `; restart remains unsafe (${reason})` : "";
    return `${recovery?.packageRollbackVerified ? "package rollback verified; " : ""}verified serving ${bounded(version, 120)}${constraint}`;
  }
  const code = observation.failureFacts?.[0]?.code;
  if (!code) {
    return "Gateway readiness is pending; recovery check completed without verified readiness";
  }
  return code === "gateway-probe-failed"
    ? `recovery check failed (${code})`
    : code === "stopped-free"
      ? `not serving (${code})`
      : `readiness unverified (${code})`;
}

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${sliceUtf16Safe(text, 0, limit - 1)}…`;
}

/** Project legacy runner results into the facts used by manual reports and summaries. */
export function updateRunReportInputFromResult(
  result: UpdateRunResult,
  recorded?: Partial<UpdateRunReportInput>,
): UpdateRunReportInput {
  const steps = result.steps.flatMap(updateRunStepsFromResultStep);
  const observationStep = (name: string) =>
    name === "gateway verification" || name === "gateway recovery verification";
  const observations = steps.filter((entry) => observationStep(entry.step));
  const preserveRecorded = result.status === "ok" && result.verification === undefined;
  const { booted, noticeDelivered, doctorHint, recovery, rollbackOutcome } =
    recorded?.verification ?? {};
  const resultStatus =
    result.status === "ok" ? "succeeded" : result.status === "error" ? "failed" : "skipped";
  // Failed diagnostics may not have reached the ledger yet.
  const recordedOutcome = result.status === "error" ? undefined : recorded;
  return {
    status:
      recordedOutcome?.status ??
      (recorded?.status === "rolled-back" && isVerifiedUpdateRollback(result)
        ? "rolled-back"
        : resultStatus),
    phase: recordedOutcome?.phase ?? "finished",
    reason:
      recordedOutcome?.reason !== undefined
        ? recordedOutcome.reason
        : (result.reason ?? recorded?.reason ?? null),
    origin: recorded?.origin ?? {},
    target: recorded?.target,
    createdAtMs: recorded?.createdAtMs,
    finishedAtMs: recorded?.finishedAtMs,
    before: recordedOutcome?.before ?? result.before ?? recorded?.before ?? {},
    after: recordedOutcome?.after ?? result.after ?? recorded?.after ?? {},
    repair: recorded?.repair ?? [],
    downtimeMs: recorded?.downtimeMs ?? null,
    verification:
      preserveRecorded && recorded?.verification
        ? recorded.verification
        : {
            ...(result.verification ?? recorded?.verification),
            ...(recorded?.verification ? { booted, noticeDelivered, doctorHint } : {}),
            recovery:
              recovery?.serviceRestartSafe === false
                ? recovery
                : (result.recovery ?? (result.verification === undefined ? recovery : undefined)),
            rollbackOutcome: result.rollbackOutcome ?? rollbackOutcome,
          },
    steps: !recorded?.steps
      ? steps
      : !preserveRecorded && (result.verification !== undefined || observations.length)
        ? [...recorded.steps.filter((entry) => !observationStep(entry.step)), ...observations]
        : recorded.steps,
  };
}

/** Stable releases can leave a pre-ledger sentinel across an upgrade. */
export function updateRunReportInputFromSentinel(
  payload: RestartSentinelPayload,
): UpdateRunReportInput {
  const stats = payload.stats;
  const version = (value: Record<string, unknown> | null | undefined) => ({
    ...(typeof value?.version === "string" ? { version: value.version } : {}),
    ...(typeof value?.sha === "string" ? { sha: value.sha } : {}),
  });
  const pending =
    payload.status === "skipped" &&
    (stats?.reason === "managed-service-handoff-started" ||
      stats?.reason === "restart-health-pending");
  return {
    status: pending
      ? "running"
      : payload.status === "ok"
        ? "succeeded"
        : payload.status === "error"
          ? "failed"
          : "skipped",
    phase: pending ? "restarting" : "finished",
    reason: stats?.reason ?? null,
    origin: payload.doctorHint ? { doctorHint: payload.doctorHint } : {},
    before: version(stats?.before),
    after: version(stats?.after),
    verification: {},
    repair: [],
    downtimeMs: null,
    steps: (stats?.steps ?? []).map((step) => ({
      step: step.name,
      status: step.log?.exitCode === 0 ? "completed" : "failed",
      failureFacts: step.failureFacts,
    })),
  };
}
