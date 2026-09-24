import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
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
import type { UpdateRunReportHealth } from "./update-run-report-health.js";
import { updateRunStepsFromResultStep, updateRunWarningMessages } from "./update-run-step.js";
import type { UpdateRunResult } from "./update-runner-types.js";
import { formatUpdateSnapshotCapacity } from "./update-snapshot-capacity.js";

export type UpdateRunReport = { headline: string; lines: string[]; markdown: string };
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
>;
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
  const version =
    recovery?.serviceRestartSafe && recovery.service === "healthy"
      ? recovery.version
      : verification.versionMatch && verification.readyz && verification.settled
        ? verification.runningVersion
        : undefined;
  if (observation.exitCode === 0 && version && !observation.failureFacts?.length) {
    const constraint =
      recovery?.serviceRestartSafe === false ? `; restart remains unsafe (${reason})` : "";
    return `${recovery?.packageRollbackVerified ? "package rollback verified; " : ""}verified serving ${bounded(version, 120)}${constraint}`;
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
  const from = run.before.version ? bounded(run.before.version, 120) : undefined;
  const target = run.after.version ?? run.target.version;
  const to = target ? bounded(target, 120) : undefined;
  if (kind === "ack") {
    return `⬆️ Updating OpenClaw ${from ?? "the current version"} → ${to ?? "the latest release"}. The gateway stays available while the update is validated; you'll get a message here when it finishes.`;
  }
  if (kind === "activating" || kind === "parking") {
    return `⏳ Restarting the gateway now${from && to ? ` (v${from} → v${to})` : ""}…`;
  }
  const running = run.verification.runningVersion
    ? bounded(run.verification.runningVersion, 120)
    : to;
  return `🔁 Back${running ? ` on v${running}` : ""}, verifying…`;
}

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${sliceUtf16Safe(text, 0, limit - 1)}…`;
}

function recoveryHints(run: ReportInput, nextAction?: string): string[] {
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
  const hints: string[] = [];
  if (run.reason === "preflight-insufficient-space") {
    hints.push(
      "Free space on the preflight staging and package-manager store filesystems, then rerun the update.",
    );
  } else if (run.reason === "pnpm-corepack-missing") {
    hints.push(
      "This pnpm checkout could not auto-enable pnpm because corepack is missing. Install pnpm manually or install Node with corepack available, then rerun the update command.",
    );
  } else if (run.reason === "pnpm-corepack-enable-failed") {
    hints.push(
      "Run corepack enable manually or install pnpm manually, then rerun the update command.",
    );
  } else if (run.reason === "pnpm-npm-bootstrap-failed") {
    hints.push(
      "This pnpm checkout could not bootstrap pnpm from npm automatically. Install pnpm manually, then rerun the update command.",
    );
  } else if (run.reason === "preferred-manager-unavailable") {
    hints.push(
      "Install the checkout's declared package manager manually, then rerun the update command.",
    );
  }
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
    (run.status !== "running" && opts.nextAction === undefined && run.origin.nextAction
      ? { kind: "unavailable" }
      : undefined);
  // Git updates can change commits without changing the package version.
  const before = run.before.sha?.slice(0, 8) ?? run.before.version;
  const after = run.after.sha?.slice(0, 8) ?? run.after.version;
  const reason = bounded(
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
          : `⚠️ OpenClaw update failed: ${reason}.${running ? ` The gateway is running ${running}.` : ""}`;
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
      headline = `⬆️ OpenClaw update in progress: ${run.phase}.`;
      break;
  }
  headline = bounded(headline, 500);
  const lines: string[] = [];
  if (opts.mode && opts.mode !== "unknown") {
    lines.push(`Update mode: ${opts.mode}`);
  }
  for (const step of run.steps) {
    if (step.snapshotCapacity) {
      lines.push(formatUpdateSnapshotCapacity(step.snapshotCapacity));
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
    lines.push(bounded(failure, 300));
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
  for (const message of updateRunWarningMessages(run.steps, 3)) {
    lines.push(`Warning: ${bounded(message, 500)}`);
  }
  const verification: string[] = [];
  const facts = run.verification;
  const observation = run.steps.findLast((step) => step.step === "gateway recovery verification");
  const recovery = observation && formatUpdateRunRecovery(facts, observation);
  if (recovery) {
    lines.push(`Recovery: ${recovery}.`);
  }
  if (facts.booted) {
    verification.push("gateway booted");
  }
  if (facts.serviceRunning !== undefined) {
    verification.push(facts.serviceRunning ? "service running" : "service stopped");
  }
  const identity = formatUpdateRunIdentity(facts, run.after);
  if (identity) {
    verification.push(identity);
  }
  if (facts.channelsReady !== undefined) {
    verification.push(facts.channelsReady ? "channels ready" : "channels not ready");
  }
  if (facts.readyz !== undefined) {
    verification.push(facts.readyz ? "HTTP ready" : "HTTP not ready");
  }
  if (facts.pluginErrors?.length) {
    verification.push(`${facts.pluginErrors.length} plugin activation error(s)`);
  }
  if (verification.length) {
    lines.push(
      `${currentHealth ? "Recorded verification" : "Verification"}: ${verification.join("; ")}.`,
    );
  }
  if (currentHealth && !run.origin.nextAction && !opts.nextAction) {
    lines.push(formatUpdateRunCurrentHealth(currentHealth));
  }
  for (const attempt of run.repair.slice(-3)) {
    lines.push(
      bounded(
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
  const nextAction =
    savedAction && currentHealth
      ? `${formatUpdateRunCurrentHealth(currentHealth)} ${
          currentHealth.kind === "responding"
            ? "This observation supersedes saved claims that the Gateway is stopped; other recovery constraints still apply. The recorded update outcome is unchanged."
            : "Check current Gateway status before acting on this saved advice."
        }\nHistorical recovery advice: “${savedAction}”`
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
  lines.push(...hints);
  const next = hints.at(-1);
  const body = [headline, ...lines.filter((line) => line !== next)].join("\n");
  const suffix = next ? `\n${bounded(next, 1100)}` : "";
  return { headline, lines, markdown: `${bounded(body, 1500 - suffix.length)}${suffix}` };
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
