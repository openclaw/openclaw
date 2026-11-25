import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { UPDATE_RUN_PHASES } from "../../../packages/gateway-protocol/src/update-run-vocabulary.js";
import {
  projectUpdateRunHistory,
  type UpdateRunServingIdentity,
} from "../../../src/infra/update-run-history-projection.ts";
import {
  isAcknowledgedAbandonedUpdateRun,
  isUpdateRepairRun,
  type UpdateRunRecord,
  type UpdateRunStep,
} from "../../../src/infra/update-run-record.ts";
import {
  renderUpdateRunReport,
  resolveUpdateRunIdentity,
} from "../../../src/infra/update-run-report.ts";
import { t } from "../i18n/index.ts";
import { registerUpdateActionsEnglish } from "../i18n/locales/en-update-actions.ts";

registerUpdateActionsEnglish();

export function updateRunStepOwner(step: string): string {
  // Diagnostic suffixes identify ledger receipts, not additional installation work.
  return step.replace(/^(?:diagnostic|warning):(.+?)(?::\d+)?$/u, "$1");
}

function isServingUpdateTarget(
  run: UpdateRunRecord,
  { version, buildId }: UpdateRunServingIdentity,
) {
  const { reason, before, after, target, verification } = run;
  const rollback = verification.rollbackOutcome?.status;
  // Rollback can rewrite `after` with the restored package, even at the same version.
  if (
    (reason !== "post-update-failed" &&
      reason !== "version-mismatch" &&
      reason !== "build-id-mismatch") ||
    rollback === "succeeded" ||
    rollback === "failed" ||
    verification.recovery?.packageRollbackVerified ||
    (after.version && after.version !== version) ||
    (target.version && target.version !== version) ||
    (target.sha && target.sha !== after.sha)
  ) {
    return false;
  }
  return after.buildId
    ? buildId === after.buildId &&
        buildId !== before.buildId &&
        buildId !== verification.runningBuildId
    : reason !== "build-id-mismatch" &&
        target.kind === "package" &&
        Boolean(
          version &&
          target.version === version &&
          verification.runningVersion &&
          version !== verification.runningVersion &&
          version !== before.version,
        );
}

export function projectUpdateRun(
  run: UpdateRunRecord,
  connected = true,
  serving?: UpdateRunServingIdentity,
) {
  const terminal = run.status !== "running";
  // Machine lint receipts stay in saved diagnostics, not user-facing steps or output.
  const visibleSteps = run.steps.filter(({ step }) => !step.startsWith("finalize:doctor-lint:"));
  const repairRun = isUpdateRepairRun(run);
  const managedByOcm = run.target.installationMethod === "ocm";
  const historical = connected ? projectUpdateRunHistory(run, serving) : null;
  const targetNote =
    historical && serving && isServingUpdateTarget(run, serving)
      ? t("updates.run.servingTarget")
      : null;
  const report = historical
    ? {
        headline: historical,
        lines: targetNote ? [targetNote] : [],
        markdown: targetNote ? `${historical}\n\n${targetNote}` : historical,
      }
    : renderUpdateRunReport(run);
  const currentIndex = UPDATE_RUN_PHASES.indexOf(run.phase);
  const phases = UPDATE_RUN_PHASES.flatMap((phase, index) => {
    const recorded = visibleSteps.find((step) => step.step === phase);
    if (
      !recorded &&
      phase !== run.phase &&
      (phase === "repairing" || (repairRun && phase !== "finished"))
    ) {
      return [];
    }
    let status: UpdateRunStep["status"] = recorded?.status ?? "pending";
    if (!recorded) {
      if (phase === "finished" && terminal) {
        status =
          run.status === "succeeded"
            ? "completed"
            : run.status === "skipped"
              ? "skipped"
              : "failed";
      } else if (phase === run.phase) {
        status = "in_progress";
      } else if (terminal || index < currentIndex) {
        // A phase absent from the durable timeline was not performed, even on success.
        status = "skipped";
      }
    }
    return [{ step: phase, status, label: t(`updates.run.phase.${phase}`) }];
  });
  // Supplemental receipts share the ledger but do not represent installation steps.
  const steps = visibleSteps.filter(
    (step) =>
      !step.step.startsWith("notice:") &&
      !step.step.startsWith("diagnostic:") &&
      !UPDATE_RUN_PHASES.some((phase) => phase === step.step),
  );
  // An active operation owns the panel even before it has emitted diagnostic text.
  const detailStep =
    steps.findLast((step) => step.status === "in_progress") ??
    visibleSteps.findLast((step) => step.status === "in_progress" && step.detail) ??
    visibleSteps.findLast((step) => step.detail);
  const groupedDetails = new Map<string, string[]>();
  for (const step of visibleSteps) {
    if (!step.detail) {
      continue;
    }
    const owner = updateRunStepOwner(step.step);
    const lines = groupedDetails.get(owner) ?? [];
    lines.push(step.detail);
    groupedDetails.set(owner, lines);
  }
  const stepDetails = new Map<string, string>(
    Array.from(groupedDetails, ([owner, lines]) => [
      owner,
      sliceUtf16Safe(lines.join("\n"), -4096).split(/\r?\n/u).slice(-80).join("\n"),
    ]),
  );
  const details = detailStep ? (stepDetails.get(updateRunStepOwner(detailStep.step)) ?? "") : "";
  const facts = run.verification;
  const identity = resolveUpdateRunIdentity(facts, run.after);
  const booleanState = (value: boolean | undefined): "pass" | "warn" | "fail" | "pending" =>
    value === undefined ? (terminal ? "warn" : "pending") : value ? "pass" : "fail";
  const oracles = [
    {
      name: "service",
      state: booleanState(facts.serviceRunning),
      observed: facts.serviceRunning !== undefined,
    },
    {
      name: "version",
      state:
        identity.kind === "unavailable"
          ? "warn"
          : booleanState(identity.kind === "unobserved" ? undefined : identity.kind === "verified"),
      observed: identity.kind !== "unobserved",
    },
    {
      name: "plugins",
      state: booleanState(
        facts.pluginErrors === undefined ? undefined : facts.pluginErrors.length === 0,
      ),
      observed: facts.pluginErrors !== undefined,
    },
    {
      name: "channels",
      state: booleanState(facts.channelsReady),
      observed: facts.channelsReady !== undefined,
    },
  ] as const;
  const completed = phases.filter((phase) => phase.status === "completed").length;
  const total = phases.filter((phase) => phase.status !== "skipped").length;
  return {
    report,
    terminal,
    reconciled: isAcknowledgedAbandonedUpdateRun(run),
    headline:
      !connected &&
      !terminal &&
      (run.phase === "activating" || run.phase === "restarting" || run.phase === "verifying")
        ? t("updates.run.restarting")
        : report.headline,
    compactLabel: managedByOcm
      ? ""
      : t("updates.run.progress", { completed: String(completed), total: String(total) }),
    phases: managedByOcm
      ? []
      : phases.map(({ step, status, label }) => ({
          step,
          status,
          label,
          detail: stepDetails.get(step),
        })),
    steps: steps.map(({ step, status }) => ({
      step,
      status,
      detail: stepDetails.get(updateRunStepOwner(step)),
    })),
    detailStep: detailStep?.step,
    details,
    historicalVerificationLabel: historical ? t("updates.run.recordedVerification") : undefined,
    oracles: managedByOcm ? [] : oracles.filter((oracle) => !terminal || oracle.observed),
  };
}
