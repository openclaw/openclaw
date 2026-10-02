import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import {
  formatUpdateActivationTimeoutGuidance,
  isVerifiedUpdateRollback,
  UPDATE_ACTIVATION_TIMEOUT_REASON,
  UPDATE_FOREIGN_DESTINATION_REASON,
  UPDATE_INSTALL_SKIP_GUIDANCE,
} from "../shared/update-outcome.js";
import { formatDurationPrecise } from "./format-time/format-duration.ts";
import type { RestartSentinelPayload } from "./restart-sentinel-store.js";
import { UPDATE_DESTINATION_RECOVERY } from "./update-destination-failure.js";
import { formatUpdateDoctorConfigWriteRefusal } from "./update-doctor-config.js";
import {
  formatUpdateFailureFact,
  selectUpdateFailureReportSteps,
} from "./update-failure-facts-format.js";
import {
  LEGACY_UPDATE_RUN_ADVISORY,
  LEGACY_UPDATE_RUN_EXPIRED_REASON,
} from "./update-run-legacy-expiry.js";
import { isAcknowledgedAbandonedUpdateRun, type UpdateRunRecord } from "./update-run-record.js";
import * as cap from "./update-run-report-cap.js";
import type { UpdateRunReportHealth } from "./update-run-report-health.js";
import {
  updateRunServiceWarning,
  updateRunStepsFromResultStep,
  updateRunWarningMessages,
} from "./update-run-step.js";
import type { UpdateRunResult } from "./update-runner-types.js";
import { formatUpdateSnapshotCapacity } from "./update-snapshot-capacity.js";

export { formatUpdateRunCurrentHealth } from "./update-run-report-cap.js";

export type UpdateRunReport = { headline: string; lines: string[]; markdown: string };

const IN_PROGRESS_REPORT_PREFIX = "⬆️ OpenClaw update in progress: ";
const FAILURE_RECOVERY_HINTS: Readonly<Record<string, string>> = {
  "preflight-insufficient-space":
    "Free space on the preflight staging and package-manager store filesystems, then rerun the update.",
  "pnpm-corepack-missing":
    "This pnpm checkout could not auto-enable pnpm because corepack is missing. Install pnpm manually or install Node with corepack available, then rerun the update command.",
  "pnpm-corepack-enable-failed":
    "Run corepack enable manually or install pnpm manually, then rerun the update command.",
  "pnpm-npm-bootstrap-failed":
    "This pnpm checkout could not bootstrap pnpm from npm automatically. Install pnpm manually, then rerun the update command.",
  "preferred-manager-unavailable":
    "Install the checkout's declared package manager manually, then rerun the update command.",
};

/** Recognizes pending projections written by this renderer, including shipped reports. */
export function isUpdateRunReportInProgress(markdown: string): boolean {
  return markdown.startsWith(IN_PROGRESS_REPORT_PREFIX);
}

export type UpdateRunNoticeKind = "ack" | "parking" | "activating" | "verifying" | "finished";
type ReportInput = Pick<
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
  Partial<Pick<UpdateRunRecord, "target">>;
const PHASES = new Set<string>(UPDATE_RUN_PHASES);

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
    const version = cap.bounded(recovery.version, 120);
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
  const version =
    recovery?.serviceRestartSafe && recovery.service === "healthy"
      ? recovery.version
      : verification.versionMatch && verification.readyz && verification.settled
        ? verification.runningVersion
        : undefined;
  if (observation.exitCode === 0 && version && !observation.failureFacts?.length) {
    const constraint =
      recovery?.serviceRestartSafe === false ? `; restart remains unsafe (${reason})` : "";
    return `${recovery?.packageRollbackVerified ? "package rollback verified; " : ""}verified serving ${cap.bounded(version, 120)}${constraint}`;
  }
  const code = observation.failureFacts?.[0]?.code;
  if (!code) {
    return "Gateway readiness is pending; recovery probe completed without verified readiness";
  }
  return code === "gateway-probe-failed"
    ? `recovery probe failed (${code})`
    : `not serving (${code})`;
}

/** The four conversation milestones share the run's recorded versions and final report. */
export function renderUpdateRunNotice(
  run: UpdateRunRecord,
  kind: UpdateRunNoticeKind,
  options: { currentHealth?: UpdateRunReportHealth } = {},
): string | null {
  if (kind === "finished") {
    return run.status === "running" ? null : renderUpdateRunReport(run, options).markdown;
  }
  // Managed parking precedes updater staging; its notice must not advance the ledger phase.
  const noticePhase = kind === "ack" || kind === "parking" ? "requested" : kind;
  if (run.status !== "running" || run.phase !== noticePhase) {
    return null;
  }
  const from = run.before.version ? cap.bounded(run.before.version, 120) : undefined;
  const target = run.after.version ?? run.target.version;
  const to = target ? cap.bounded(target, 120) : undefined;
  if (kind === "ack") {
    return `⬆️ Updating OpenClaw ${from ?? "the current version"} → ${to ?? "the latest release"}. The gateway stays available while the update is validated; you'll get a message here when it finishes.`;
  }
  if (kind === "activating" || kind === "parking") {
    return `⏳ Restarting the gateway now${from && to ? ` (v${from} → v${to})` : ""}…`;
  }
  const running = run.verification.runningVersion
    ? cap.bounded(run.verification.runningVersion, 120)
    : to;
  return `🔁 Back${running ? ` on v${running}` : ""}, verifying…`;
}

function recoveryHints(run: ReportInput, nextAction?: string): string[] {
  if (run.target?.installationMethod === "ocm") {
    return nextAction ? [] : run.origin.nextAction ? [run.origin.nextAction] : [];
  }
  if (run.status === "running") {
    return ["Check progress with openclaw update status."];
  }
  if (run.status !== "failed") {
    return [];
  }
  if (run.reason === LEGACY_UPDATE_RUN_EXPIRED_REASON) {
    return [LEGACY_UPDATE_RUN_ADVISORY];
  }
  if (run.reason === UPDATE_ACTIVATION_TIMEOUT_REASON) {
    return nextAction ? [] : [formatUpdateActivationTimeoutGuidance()];
  }
  if (run.reason === UPDATE_FOREIGN_DESTINATION_REASON) {
    return nextAction ? [] : [`Next step: ${UPDATE_DESTINATION_RECOVERY}`];
  }
  const hint =
    run.reason && Object.hasOwn(FAILURE_RECOVERY_HINTS, run.reason)
      ? FAILURE_RECOVERY_HINTS[run.reason]
      : undefined;
  const hints = hint ? [hint] : [];
  if (!nextAction) {
    hints.push("Run openclaw triage to diagnose and repair the failed update.");
  }
  return hints;
}

/** One report for persisted update outcomes; markdown reserves room for the next action. */
export function renderUpdateRunReport(
  run: ReportInput,
  opts: {
    doctorHint?: string | null;
    nextAction?: string;
    currentHealth?: UpdateRunReportHealth;
    mode?: UpdateRunResult["mode"] | "package";
  } = {},
): UpdateRunReport {
  const reconciled = isAcknowledgedAbandonedUpdateRun(run);
  const currentHealth: UpdateRunReportHealth | undefined =
    opts.currentHealth ??
    (run.target?.installationMethod !== "ocm" &&
    run.status !== "running" &&
    opts.nextAction === undefined &&
    run.origin.nextAction
      ? { kind: "unavailable" }
      : undefined);
  // Git updates can change commits without changing the package version.
  const before = run.before.sha?.slice(0, 8) ?? run.before.version;
  const after = run.after.sha?.slice(0, 8) ?? run.after.version;
  const reason = cap.bounded(
    run.reason?.trim() ||
      (run.status === "failed" &&
        run.steps.find((step) => step.status === "failed" && step.step !== "requested")?.step) ||
      "unknown reason",
    240,
  );
  const running =
    !currentHealth && run.verification.serviceRunning === true
      ? run.verification.runningVersion
      : undefined;
  // These producer codes also cover unreadable runtimes and failed capability probes.
  // They do not establish that Node is old or that upgrading it will repair the update.
  const runtimeCheckFailed =
    run.status === "failed" &&
    (run.reason === "node-runtime-preflight" ||
      run.reason === "preflight-node-runtime-incompatible");
  let headline: string;
  switch (run.status) {
    case "succeeded":
      headline = after
        ? `✅ OpenClaw updated to ${after}${before ? ` (from ${before})` : ""}.`
        : "✅ OpenClaw updated.";
      break;
    case "failed":
      headline = reconciled
        ? "ℹ️ OpenClaw abandoned update reconciled."
        : run.reason === LEGACY_UPDATE_RUN_EXPIRED_REASON
          ? `ℹ️ OpenClaw update abandoned: ${reason}.`
          : runtimeCheckFailed
            ? "⚠️ OpenClaw could not complete the update. A required system check failed."
            : `⚠️ OpenClaw update failed: ${reason}.`;
      break;
    case "skipped":
      headline =
        run.reason === "still-starting"
          ? `ℹ️ OpenClaw${after ? ` ${after}` : ""} installed; Gateway still starting; readiness unverified; recovery backups retained.`
          : run.reason === "gateway-readiness-unverified"
            ? `ℹ️ OpenClaw${after ? ` ${after}` : ""} installed; Gateway readiness unverified; recovery backups retained.`
            : `ℹ️ OpenClaw update skipped: ${reason}.`;
      break;
    case "rolled-back":
      headline = `↩️ OpenClaw update rolled back to ${after ?? running ?? before ?? "the previous version"}: ${reason}.`;
      break;
    case "running":
      headline = `${IN_PROGRESS_REPORT_PREFIX}${run.target?.installationMethod === "ocm" ? "managed by OCM" : run.phase}.`;
      break;
  }
  headline = cap.bounded(headline, 500);
  // Saved pending reports are recognized by the running headline prefix. Compaction must retain
  // that lifecycle discriminator so terminal recovery can replace the pending projection.
  const protectedHeadline = cap.compactHeadline(run, headline, reconciled);
  const currentHealthLine =
    currentHealth && !run.origin.nextAction && !opts.nextAction
      ? cap.formatUpdateRunCurrentHealth(currentHealth)
      : undefined;
  const lines: string[] = currentHealthLine ? [currentHealthLine] : [];
  if (opts.mode && opts.mode !== "unknown") {
    lines.push(`Update mode: ${opts.mode}`);
  }
  const admission = run.origin.admission;
  if (admission) {
    const candidateVersion = admission.candidateVersion
      ? ` (${cap.bounded(admission.candidateVersion, 120)})`
      : "";
    lines.push(`Admission: ${admission.owner}${candidateVersion}.`);
    if (admission.checks?.length) {
      lines.push(
        `Admission checks: ${admission.checks.map((check) => `${cap.bounded(check.name, 120)}: ${check.status}`).join(", ")}.`,
      );
    }
    if (admission.fallbackReason) {
      lines.push(`Admission fallback: ${cap.bounded(admission.fallbackReason, 500)}`);
    }
  }
  for (const step of run.steps) {
    if (run.status === "running" && step.status === "in_progress" && step.detail) {
      lines.push(
        `Waiting: ${step.step}${step.startedAtMs !== undefined ? ` (started ${new Date(step.startedAtMs).toISOString()})` : ""} — ${step.detail}`,
      );
    }
    if (step.snapshotCapacity) {
      lines.push(formatUpdateSnapshotCapacity(step.snapshotCapacity));
    }
    if (
      step.detail &&
      (step.step.startsWith("diagnostic:database snapshot") ||
        step.step.startsWith("diagnostic:database migration writes") ||
        step.step.startsWith("diagnostic:database rollback"))
    ) {
      lines.push(step.detail);
    }
    if (step.configWriteRefusal) {
      lines.push(formatUpdateDoctorConfigWriteRefusal(step.configWriteRefusal));
    }
  }
  const configChanges = run.steps.flatMap((step) => (step.configChange ? [step.configChange] : []));
  const configKeys = [
    ...new Set(configChanges.flatMap((change) => (change.kind === "key" ? [change.key] : []))),
  ];
  if (configKeys.length) {
    lines.push(`Doctor changed config keys: ${configKeys.join(", ")}.`);
  }
  for (const message of new Set(
    configChanges.flatMap((change) => (change.kind === "migration" ? [change.message] : [])),
  )) {
    lines.push(`Warning: Doctor migration: ${message}`);
  }
  const phases = run.steps
    .filter((step) => PHASES.has(step.step))
    .map((step) => {
      const duration =
        step.startedAtMs != null && step.endedAtMs != null
          ? ` (${formatDurationPrecise(Math.max(0, step.endedAtMs - step.startedAtMs))})`
          : "";
      return `${step.step}${duration}`;
    });
  if (phases.length) {
    lines.push(`Phases: ${phases.join(" → ")}`);
  }
  for (const step of selectUpdateFailureReportSteps(
    run.steps.filter((item) => item.status === "failed"),
  )) {
    const failure = `Failed: ${step.step}${step.detail ? ` — ${step.detail}` : ""}`;
    lines.push(cap.bounded(failure, 300));
    lines.push(
      ...(step.failureFacts ?? []).slice(0, 5).map((fact) =>
        formatUpdateFailureFact({
          ...fact,
          message:
            failure.length <= 300 && fact.message && step.detail?.includes(fact.message)
              ? undefined
              : fact.message,
        }),
      ),
    );
  }
  const warningStart = lines.length;
  const serviceWarning = updateRunServiceWarning(run.steps);
  const warningFormat = serviceWarning ? cap.formatServiceWarning(serviceWarning) : undefined;
  for (const message of updateRunWarningMessages(run.steps, 3)) {
    lines.push(
      message === serviceWarning && warningFormat
        ? warningFormat.report
        : `Warning: ${cap.bounded(message, 500)}`,
    );
  }
  const warningEnd = lines.length;
  const facts = run.verification;
  const observation = run.steps.findLast((step) => step.step === "gateway recovery verification");
  const recovery = observation && formatUpdateRunRecovery(facts, observation);
  const recoveryLine = recovery ? `Recorded recovery: ${recovery}.` : undefined;
  const recoveryCode = observation?.failureFacts?.[0]?.code;
  const recoveryVersion =
    facts.recovery?.serviceRestartSafe && facts.recovery.service === "healthy"
      ? facts.recovery.version
      : facts.versionMatch && facts.readyz && facts.settled
        ? facts.runningVersion
        : undefined;
  const recoveryServing = observation?.exitCode === 0 && recoveryVersion && !recoveryCode;
  const restartUnsafe = facts.recovery?.serviceRestartSafe === false;
  const protectedRecoveryState = recoveryCode
    ? recoveryCode === "gateway-probe-failed"
      ? `probe failed${restartUnsafe ? "; restart unsafe" : ""}`
      : `not serving${restartUnsafe ? "; restart unsafe" : ""}`
    : recoveryServing
      ? restartUnsafe
        ? "serving; restart unsafe"
        : "serving verified"
      : facts.recovery?.packageRollbackVerified
        ? restartUnsafe
          ? "rollback done; restart unsafe"
          : "rollback done; pending"
        : restartUnsafe
          ? "pending; restart unsafe"
          : "readiness pending";
  const protectedRecoveryLine = recoveryLine ? `Recovery: ${protectedRecoveryState}.` : undefined;
  if (recoveryLine) {
    lines.push(recoveryLine);
  }
  const verification = [
    facts.booted ? "gateway booted" : undefined,
    facts.serviceRunning === undefined
      ? undefined
      : facts.serviceRunning
        ? `service running${facts.runningVersion ? ` (${cap.bounded(facts.runningVersion, 120)})` : ""}`
        : "service stopped",
    formatUpdateRunIdentity(facts, run.after),
    facts.channelsReady === undefined
      ? undefined
      : facts.channelsReady
        ? "channels ready"
        : "channels not ready",
    facts.readyz === undefined ? undefined : facts.readyz ? "HTTP ready" : "HTTP not ready",
    facts.pluginErrors?.length
      ? `${facts.pluginErrors.length} plugin activation error(s)`
      : undefined,
  ].filter(Boolean);
  const verificationLine = verification.length
    ? `Recorded verification: ${verification.join("; ")}.`
    : undefined;
  const identity = resolveUpdateRunIdentity(facts, run.after);
  const protectedVerificationState =
    facts.serviceRunning === false
      ? facts.pluginErrors?.length
        ? "stopped; plugin errors"
        : "stopped"
      : facts.readyz === false
        ? "HTTP not ready"
        : facts.channelsReady === false
          ? "channels not ready"
          : facts.pluginErrors?.length
            ? "plugin errors"
            : identity.kind === "mismatch"
              ? `${identity.field} mismatch`
              : identity.kind === "unavailable"
                ? "identity unavailable"
                : facts.readyz === true
                  ? facts.channelsReady === true
                    ? "serving; channels ready"
                    : "serving"
                  : facts.serviceRunning === true
                    ? facts.channelsReady === true
                      ? "running; channels ready"
                      : "service running"
                    : facts.versionMatch === true
                      ? facts.channelsReady === true
                        ? "version; channels ready"
                        : "version verified"
                      : facts.booted && facts.channelsReady === true
                        ? "booted; channels ready"
                        : facts.booted
                          ? "booted"
                          : facts.channelsReady === true
                            ? "channels ready"
                            : "checks recorded";
  const protectedVerificationLine = verificationLine
    ? `Verification: ${protectedVerificationState}.`
    : undefined;
  if (verificationLine) {
    lines.push(verificationLine);
  }
  for (const attempt of run.repair.slice(-3)) {
    lines.push(
      cap.bounded(
        `Repair ${attempt.attempt}: ${attempt.status}${attempt.summary || attempt.reason ? ` — ${attempt.summary ?? attempt.reason}` : ""}`,
        300,
      ),
    );
  }
  if (run.downtimeMs != null) {
    lines.push(`Gateway downtime: ${formatDurationPrecise(run.downtimeMs)}.`);
  }
  const skipGuidance =
    run.status === "skipped" &&
    run.reason &&
    Object.hasOwn(UPDATE_INSTALL_SKIP_GUIDANCE, run.reason)
      ? UPDATE_INSTALL_SKIP_GUIDANCE[run.reason]
      : undefined;
  const savedAction = opts.nextAction ?? run.origin.nextAction ?? skipGuidance;
  const currentHealthQualification =
    savedAction && currentHealth
      ? `${cap.formatUpdateRunCurrentHealth(currentHealth)} ${
          currentHealth.kind === "responding"
            ? "This observation supersedes saved claims that the Gateway is stopped; other recovery constraints still apply. The recorded update outcome is unchanged."
            : "Check current Gateway status before acting on this saved advice."
        }`
      : undefined;
  const nextAction =
    savedAction && currentHealthQualification
      ? `${currentHealthQualification}\nHistorical recovery advice: “${savedAction}”`
      : savedAction;
  const lastRepairReason = run.repair.at(-1)?.reason;
  const repairStopReason =
    lastRepairReason === "requester-revoked" || lastRepairReason === "repair-requires-config-change"
      ? lastRepairReason
      : run.reason;
  const repairHint =
    run.status === "failed" && repairStopReason === "requester-revoked"
      ? nextAction
        ? "Repair stopped because the chat requester is no longer a command owner. Further recovery requires a current command owner."
        : "Repair stopped because the chat requester is no longer a command owner. A current command owner must start a new update, or the operator can run openclaw triage locally."
      : run.status === "failed" && repairStopReason === "repair-requires-config-change"
        ? nextAction
          ? "Doctor could not promote config changes. Review the named keys and writer refusal before continuing recovery."
          : "Doctor could not promote config changes. Review the named keys and writer refusal, then run openclaw doctor --fix under your own authority, or openclaw triage."
        : undefined;
  const hints = reconciled
    ? []
    : run.status === "running"
      ? opts.nextAction
        ? [opts.nextAction]
        : recoveryHints(run)
      : repairHint
        ? [repairHint, ...(nextAction ? [nextAction] : [])]
        : [
            ...new Set(
              [
                // Install ownership refusals need the deployment workflow, not Doctor repair.
                skipGuidance
                  ? undefined
                  : (opts.doctorHint ?? facts.doctorHint ?? run.origin.doctorHint),
                ...recoveryHints(run, nextAction),
                nextAction,
              ].filter((line): line is string => Boolean(line)),
            ),
          ];
  const next = hints.at(-1);
  const overflowsQualifiedAction =
    next !== undefined &&
    next === nextAction &&
    savedAction !== undefined &&
    currentHealthQualification !== undefined &&
    next.length > 1100;
  const suffixAction = overflowsQualifiedAction
    ? `Historical recovery advice: ${savedAction}`
    : next;
  const overflowHealth =
    overflowsQualifiedAction && currentHealthQualification ? currentHealthQualification : undefined;
  const protectedOverflowHealth = overflowHealth
    ? currentHealth?.kind === "responding"
      ? "Health: responding; stop advice stale."
      : "Health: unknown; verify saved advice."
    : undefined;
  const protectedServiceWarningLine = warningFormat?.protected;
  const reservedServiceWarningLine = warningFormat?.reserve
    ? protectedServiceWarningLine
    : undefined;
  const runtimeSafetyLines = [
    protectedServiceWarningLine,
    protectedRecoveryLine,
    protectedVerificationLine,
    currentHealthLine,
    protectedOverflowHealth,
  ].filter((line): line is string => Boolean(line));
  const minWarnings = serviceWarning ? 1 : 0;
  if (runtimeCheckFailed) {
    // Keep the owner's selected action ahead of the diagnostic dump, including
    // historical-advice qualifications. Neither this layout nor truncation selects recovery.
    const details = [
      "Details:",
      `Reason code: ${reason}`,
      ...lines,
      ...hints.filter((line) => line !== next),
    ];
    const actionLine = suffixAction ? cap.bounded(suffixAction, 1100) : undefined;
    const detailsLines = overflowHealth ? [...details, overflowHealth] : details;
    // Fresh responding health outranks the details label and reason. Keeping both beside
    // maximum recovery inputs can hide live health and make stale stop advice look current.
    return {
      headline,
      lines: [...(next ? [next, ""] : []), ...details],
      markdown: cap.renderRuntimeDetails({
        headline,
        compactHeadline: protectedHeadline,
        actionLine,
        details: detailsLines,
        reasonLine: `Reason code: ${reason}`,
        safetyLines: runtimeSafetyLines,
        omitReason: Boolean(protectedOverflowHealth && currentHealth?.kind === "responding"),
        reservedLine: reservedServiceWarningLine,
      }),
    };
  }
  lines.push(...hints);
  const suffix = suffixAction ? `\n${cap.bounded(suffixAction, 1100)}` : "";
  const budget = 1500 - suffix.length;
  // Advisory warnings yield the chat budget before the recovery and verification facts
  // after them. Trailing warnings go first; the operator's restart command leads and never yields.
  const renderBody = (keptWarnings: number) => {
    const omitted = warningEnd - warningStart - keptWarnings;
    return [
      headline,
      ...lines.slice(0, warningStart + keptWarnings),
      ...(omitted > 0
        ? [
            `Warning: ${omitted} ${keptWarnings ? "more " : ""}warning${omitted === 1 ? "" : "s"} omitted; run openclaw update status for the full report.`,
          ]
        : []),
      ...lines.slice(warningEnd),
      ...(overflowHealth ? [overflowHealth] : []),
    ]
      .filter((line) => line !== next)
      .join("\n");
  };
  let keptWarnings = warningEnd - warningStart;
  let body = renderBody(keptWarnings);
  while (body.length > budget && keptWarnings > minWarnings) {
    keptWarnings -= 1;
    body = renderBody(keptWarnings);
  }
  if (body.length > budget) {
    body = cap.renderProtected(
      [
        protectedHeadline,
        protectedServiceWarningLine,
        protectedRecoveryLine,
        protectedVerificationLine,
        currentHealthLine,
        protectedOverflowHealth,
      ].filter((line): line is string => Boolean(line)),
      budget,
      reservedServiceWarningLine,
    );
  }
  return { headline, lines, markdown: `${body}${suffix}` };
}

/** Old CLI finalization paths still return runner results; all wording stays in the report. */
export function updateRunReportInputFromResult(
  result: UpdateRunResult,
  recorded?: Partial<ReportInput>,
): ReportInput {
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
export function updateRunReportInputFromSentinel(payload: RestartSentinelPayload): ReportInput {
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
