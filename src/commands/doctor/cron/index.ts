// Doctor cron repair orchestration for legacy stores, run logs, payloads, and warnings.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { loadCronQuarantinedJobs, resolveCronJobsStorePath } from "../../../cron/store.js";
import type { HealthFinding } from "../../../flows/health-checks.js";
import { formatErrorMessage as errorMessage } from "../../../infra/errors.js";
import { RetiredStateFormatError } from "../../../infra/state-migrations.retired-files.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { shortenHomePath } from "../../../utils.js";
import type { DoctorPrompter, DoctorOptions } from "../../doctor-prompter.js";
import { countLabel as pluralize } from "../../doctor-state-integrity-format.js";
import {
  applyLegacyCronStoreRepair,
  loadLegacyCronRepairState,
  type LegacyCronRepairState,
} from "./legacy-repair.js";
import {
  formatLegacyIssuePreview,
  formatLegacyGatewayExecAdvisory,
  formatScheduledToolPolicyAdvisory,
  formatUnresolvedCommandPromptAdvisory,
  formatUnresolvedShellPromptAdvisory,
} from "./repair-plan.js";
import { rethrowSqliteSchemaVersionError } from "./schema-safety.js";
import { normalizeStoredCronJobs } from "./store-migration.js";
import { noteCronDeliveryTargetAdvisory, noteCronModelOverrides } from "./warnings.js";

export {
  collectLegacyWhatsAppCrontabHealthWarning,
  noteLegacyWhatsAppCrontabHealthCheck,
} from "./warnings.js";

function readLegacyCronStorePath(cfg: OpenClawConfig): string | undefined {
  return (cfg.cron as (NonNullable<OpenClawConfig["cron"]> & { store?: string }) | undefined)
    ?.store;
}

// Scheduler startup owns interruption recovery; Doctor only reports retained markers.
function countInFlightCronJobs(jobs: Array<Record<string, unknown>>): number {
  return jobs.filter((job) => {
    const state = job.state;
    return (
      typeof state === "object" &&
      state !== null &&
      typeof (state as { runningAtMs?: unknown }).runningAtMs === "number"
    );
  }).length;
}

// The advisory threshold is independent of the scheduler's transient-retry budget.
const CHRONIC_FAILURE_MIN_CONSECUTIVE_ERRORS = 3;

function countChronicallyFailingCronJobs(jobs: Array<Record<string, unknown>>): number {
  return jobs.filter((job) => {
    // Match the scheduler: only an explicit false disables a job.
    if (job.enabled === false) {
      return false;
    }
    const state = job.state;
    if (typeof state !== "object" || state === null) {
      return false;
    }
    const consecutiveErrors = (state as { consecutiveErrors?: unknown }).consecutiveErrors;
    return (
      typeof consecutiveErrors === "number" &&
      consecutiveErrors >= CHRONIC_FAILURE_MIN_CONSECUTIVE_ERRORS
    );
  }).length;
}

type AutoDisabledCronJob = {
  id: string;
  name: string;
  reason: "consecutive-failures" | "schedule-errors";
  consecutiveErrors: number;
};

function collectAutoDisabledCronJobs(jobs: Array<Record<string, unknown>>): AutoDisabledCronJob[] {
  const autoDisabledJobs: AutoDisabledCronJob[] = [];
  for (const job of jobs) {
    if (job.enabled !== false || typeof job.id !== "string") {
      continue;
    }
    const state = job.state;
    if (!isRecord(state)) {
      continue;
    }
    const autoDisabled = state.autoDisabled;
    if (!isRecord(autoDisabled)) {
      continue;
    }
    if (
      (autoDisabled.reason !== "consecutive-failures" &&
        autoDisabled.reason !== "schedule-errors") ||
      typeof autoDisabled.consecutiveErrors !== "number"
    ) {
      continue;
    }
    autoDisabledJobs.push({
      id: job.id,
      name: typeof job.name === "string" && job.name.trim() ? job.name.trim() : job.id,
      reason: autoDisabled.reason,
      consecutiveErrors: autoDisabled.consecutiveErrors,
    });
  }
  return autoDisabledJobs;
}

const LEGACY_CRON_STORE_CHECK_ID = "core/doctor/legacy-cron-store";

function legacyCronStoreFinding(params: {
  readonly message: string;
  readonly path: string;
  readonly requirement: string;
  readonly fixHint?: string;
}): HealthFinding {
  return {
    checkId: LEGACY_CRON_STORE_CHECK_ID,
    severity: "warning",
    message: params.message,
    path: params.path,
    requirement: params.requirement,
    fixHint:
      params.fixHint ??
      `Run ${formatCliCommand("openclaw doctor --fix")} to normalize legacy cron storage.`,
  };
}

export async function collectLegacyCronStoreHealthFindings(params: {
  cfg: OpenClawConfig;
}): Promise<readonly HealthFinding[]> {
  let state: LegacyCronRepairState | null;
  try {
    state = await loadLegacyCronRepairState({ cfg: params.cfg, readOnly: true });
  } catch (err) {
    if (err instanceof RetiredStateFormatError) {
      throw err;
    }
    rethrowSqliteSchemaVersionError(err);
    const storePath = resolveCronJobsStorePath(readLegacyCronStorePath(params.cfg));
    return [
      legacyCronStoreFinding({
        message: `Unable to read cron job store at ${shortenHomePath(storePath)}.`,
        path: storePath,
        requirement: "cron-store-readable",
        fixHint: [
          `Fix the file's permissions or contents and re-run ${formatCliCommand("openclaw doctor")}.`,
          "Later health checks will continue.",
          `Details: ${errorMessage(err)}`,
        ].join(" "),
      }),
    ];
  }
  if (!state) {
    return [];
  }

  const findings: HealthFinding[] = [];
  const { storePath, legacyQuarantine, rawJobs } = state;
  const sqliteStorePath = resolveOpenClawStateSqlitePath();
  const recordFinding = (
    finding: Omit<Parameters<typeof legacyCronStoreFinding>[0], "path">,
    path = sqliteStorePath,
  ) => findings.push(legacyCronStoreFinding({ ...finding, path }));

  try {
    const quarantine = await loadCronQuarantinedJobs(storePath);
    if (quarantine.length > 0) {
      recordFinding({
        message: `${pluralize(quarantine.length, "quarantined cron job row")} found in SQLite at ${shortenHomePath(sqliteStorePath)}.`,
        requirement: "quarantined-cron-rows",
        fixHint:
          "Review or repair quarantined rows before restoring any job to the active cron store.",
      });
    }
  } catch (err) {
    rethrowSqliteSchemaVersionError(err);
    recordFinding({
      message: `Unable to read quarantined cron rows in SQLite at ${shortenHomePath(sqliteStorePath)}.`,
      requirement: "cron-quarantine-readable",
      fixHint: `Check the shared state database permissions and contents. Details: ${errorMessage(err)}`,
    });
  }

  if (legacyQuarantine) {
    recordFinding(
      {
        message: `Legacy JSON cron quarantine will be imported into SQLite from ${shortenHomePath(legacyQuarantine.path)}.`,
        requirement: "legacy-cron-quarantine",
      },
      legacyQuarantine.path,
    );
  }

  if (rawJobs.length === 0) {
    return findings;
  }

  const normalized = normalizeStoredCronJobs(rawJobs);
  for (const line of formatLegacyIssuePreview(normalized.issues)) {
    recordFinding({
      message: line.replace(/^- /u, ""),
      requirement: "legacy-cron-store-shape",
    });
  }
  for (const job of normalized.unsupportedDeliveryModeJobs) {
    recordFinding({
      message: `Cron job ${job} has an unsupported delivery mode; Doctor left it unchanged.`,
      requirement: "cron-delivery-mode-valid",
      fixHint: 'Review its intended delivery and set mode to "none", "announce", or "webhook".',
    });
  }
  for (const job of normalized.legacyTriggerScriptJobs) {
    recordFinding({
      message: `Legacy cron trigger script for ${job} can be migrated to canonical direct tool calls.`,
      requirement: "legacy-cron-trigger-script",
    });
  }
  for (const job of normalized.unsupportedLegacyTriggerScriptJobs) {
    recordFinding({
      message: `Legacy cron trigger script for ${job} cannot be safely migrated automatically.`,
      requirement: "unsupported-legacy-cron-trigger-script",
      fixHint:
        "Inspect the automation and update its trigger script manually to use direct tool calls.",
    });
  }
  for (const [names, requirement, description] of [
    [
      normalized.legacyScheduledToolPolicyJobs,
      "cron-scheduled-authority-reauthorization",
      "require explicit scheduled authority reauthorization",
    ],
    [
      normalized.invalidScheduledToolPolicyJobs,
      "cron-scheduled-authority-valid",
      "have invalid scheduled authority provenance",
    ],
  ] as const) {
    if (names.length > 0) {
      recordFinding({
        message: `${pluralize(names.length, "tool-bearing automation")} ${description}.`,
        requirement,
        fixHint: `Review with ${formatCliCommand("openclaw automations list --all")} and reauthorize with ${formatCliCommand("openclaw automations edit <id> --tools <tool,...>")}.`,
      });
    }
  }

  if (normalized.legacyGatewayExecJobs.length > 0) {
    recordFinding({
      message: `${pluralize(normalized.legacyGatewayExecJobs.length, "automation")} require recreation because they grant the retired \`gateway_exec\` alias.`,
      requirement: "legacy-gateway-exec-recreation",
      fixHint:
        "Review the affected jobs with `openclaw automations list --all`, then recreate each one from a fresh authenticated creator turn or explicitly reauthorize its complete tool cap from a trusted operator shell.",
    });
  }

  const notifyCount = rawJobs.filter((job) => job.notify === true).length;
  if (notifyCount > 0) {
    recordFinding({
      message: `${pluralize(notifyCount, "job")} still uses legacy notify webhook fallback.`,
      requirement: "legacy-notify-fallback",
    });
  }

  return findings;
}

export async function maybeRepairLegacyCronStore(params: {
  cfg: OpenClawConfig;
  options: DoctorOptions;
  prompter: Pick<DoctorPrompter, "confirm">;
}) {
  let state: LegacyCronRepairState | null;
  try {
    state = await loadLegacyCronRepairState({ cfg: params.cfg });
  } catch (err) {
    if (err instanceof RetiredStateFormatError) {
      throw err;
    }
    rethrowSqliteSchemaVersionError(err);
    const reason = err instanceof Error ? err.message : String(err);
    const storePath = resolveCronJobsStorePath(readLegacyCronStorePath(params.cfg));
    note(
      [
        `Unable to read cron job store at ${shortenHomePath(storePath)}.`,
        `- ${reason}`,
        `Fix the file's permissions or contents and re-run ${formatCliCommand("openclaw doctor")}; later health checks will continue.`,
      ].join("\n"),
      "Cron",
    );
    return;
  }
  if (!state) {
    return;
  }
  const { storePath, legacyQuarantine, invalidConfigRows, persistedQuarantine, rawJobs } = state;
  const repair = async (normalized?: ReturnType<typeof normalizeStoredCronJobs>) => {
    if (
      await params.prompter.confirm({ message: "Repair legacy cron jobs now?", initialValue: true })
    ) {
      const result = await applyLegacyCronStoreRepair({
        cfg: params.cfg,
        state,
        ...(normalized ? { normalized } : {}),
        recoverQuarantinedScheduleJobs: true,
      });
      if (result.changes.length > 0) {
        note(result.changes.join("\n"), "Doctor changes");
      }
      if (result.warnings.length > 0) {
        note(result.warnings.join("\n"), "Doctor warnings");
      }
    }
  };
  const revalidatableQuarantineCount = persistedQuarantine.filter(
    (entry) => entry.reason === "invalid-schedule" && entry.job,
  ).length;
  const sqliteStorePath = resolveOpenClawStateSqlitePath();
  try {
    const quarantine = await loadCronQuarantinedJobs(storePath);
    if (quarantine.length > 0) {
      note(
        [
          `Quarantined cron job rows found in SQLite at ${shortenHomePath(sqliteStorePath)}.`,
          `- ${pluralize(quarantine.length, "row")} was removed from the active cron store after runtime validation failed.`,
          "- Review or repair quarantined rows before restoring any job to the active cron store.",
        ].join("\n"),
        "Cron",
      );
    }
  } catch (err) {
    rethrowSqliteSchemaVersionError(err);
    const reason = err instanceof Error ? err.message : String(err);
    note(
      [
        `Unable to read quarantined cron rows in SQLite at ${shortenHomePath(sqliteStorePath)}.`,
        `- ${reason}`,
      ].join("\n"),
      "Cron",
    );
  }
  const storagePreviewLines: string[] = [];
  if (legacyQuarantine) {
    storagePreviewLines.push("- legacy JSON cron quarantine will be imported into SQLite");
  }
  if (invalidConfigRows.length > 0) {
    storagePreviewLines.push(
      `- ${pluralize(invalidConfigRows.length, "malformed cron row")} will be quarantined in SQLite`,
    );
  }
  if (revalidatableQuarantineCount > 0) {
    storagePreviewLines.push(
      `- ${pluralize(revalidatableQuarantineCount, "quarantined automation")} will be revalidated and restored only if current validation passes`,
    );
  }
  if (rawJobs.length === 0) {
    if (!legacyQuarantine && invalidConfigRows.length === 0 && revalidatableQuarantineCount === 0) {
      return;
    }
    const noteHeading = legacyQuarantine
      ? `Legacy cron storage detected at ${shortenHomePath(storePath)}.`
      : `Cron store issues detected at ${shortenHomePath(sqliteStorePath)}.`;
    note(
      [
        noteHeading,
        ...storagePreviewLines,
        `Repair with ${formatCliCommand("openclaw doctor --fix")} to finish the migration.`,
      ].join("\n"),
      "Cron",
    );
    await repair();
    return;
  }
  noteCronModelOverrides({ cfg: params.cfg, jobs: rawJobs });
  noteCronDeliveryTargetAdvisory({ cfg: params.cfg, jobs: rawJobs });

  const inFlightCount = countInFlightCronJobs(rawJobs);
  if (inFlightCount > 0) {
    const subject = inFlightCount === 1 ? "it" : "them";
    note(
      [
        `${pluralize(inFlightCount, "automation")} ${inFlightCount === 1 ? "is" : "are"} still marked in-flight (\`state.runningAtMs\` is set).`,
        `- If no gateway is currently executing ${subject}, the marker is left over from an interrupted run; the gateway marks such runs interrupted the next time it starts.`,
        `- Review with ${formatCliCommand("openclaw automations list --all")} or ${formatCliCommand("openclaw automations show <id>")}.`,
      ].join("\n"),
      "Cron",
    );
  }

  const chronicFailureCount = countChronicallyFailingCronJobs(rawJobs);
  if (chronicFailureCount > 0) {
    note(
      [
        `${pluralize(chronicFailureCount, "automation")} ${chronicFailureCount === 1 ? "has" : "have"} failed ${CHRONIC_FAILURE_MIN_CONSECUTIVE_ERRORS}+ runs in a row (\`state.consecutiveErrors\`), so the scheduler only re-fires ${chronicFailureCount === 1 ? "it" : "them"} on error backoff.`,
        `- The count resets on the next successful run and also counts runs interrupted by a gateway restart, so a lasting streak means repeated task failures, repeatedly interrupted runs, or a mix. Failure alerts are opt-in, so this may be the only notice.`,
        `- Review with ${formatCliCommand("openclaw automations list")} or ${formatCliCommand("openclaw automations show <id>")}.`,
      ].join("\n"),
      "Cron",
    );
  }

  const autoDisabledJobs = collectAutoDisabledCronJobs(rawJobs);
  if (autoDisabledJobs.length > 0) {
    note(
      [
        `${pluralize(autoDisabledJobs.length, "automation")} ${autoDisabledJobs.length === 1 ? "is" : "are"} auto-disabled after repeated failures.`,
        ...autoDisabledJobs.map(
          (job) =>
            `- ${job.name} (${job.id}): recorded reason \`${job.reason}\` after ${job.consecutiveErrors} consecutive errors. Fix the cause, then re-enable with ${formatCliCommand(`openclaw automations enable ${job.id}`)}.`,
        ),
      ].join("\n"),
      "Cron",
    );
  }

  const normalized = normalizeStoredCronJobs(rawJobs);
  if (normalized.unsupportedDeliveryModeJobs.length > 0) {
    note(
      `Unsupported cron delivery modes were left unchanged: ${normalized.unsupportedDeliveryModeJobs.join(", ")}. Review their intended delivery and set mode to "none", "announce", or "webhook".`,
      "Cron",
    );
  }
  if (normalized.unsupportedLegacyTriggerScriptJobs.length > 0) {
    note(
      [
        "Legacy cron trigger scripts cannot be safely migrated automatically:",
        ...normalized.unsupportedLegacyTriggerScriptJobs.map((job) => `- ${job}`),
        "Inspect each automation and update its trigger script manually to use direct tool calls.",
      ].join("\n"),
      "Cron",
    );
  }
  const notifyCount = rawJobs.filter((job) => job.notify === true).length;
  // Unresolved agentTurn command prompts are not auto-fixable; keep them out of the
  // --fix preview so the repair note does not promise a fix that never lands (#94655).
  for (const advisory of [
    formatUnresolvedCommandPromptAdvisory(normalized.unresolvedAgentTurnCommandPromptJobs),
    formatUnresolvedShellPromptAdvisory(normalized.unresolvedAgentTurnShellToolPromptJobs),
    formatScheduledToolPolicyAdvisory({
      legacyJobs: normalized.legacyScheduledToolPolicyJobs,
      invalidJobs: normalized.invalidScheduledToolPolicyJobs,
    }),
    formatLegacyGatewayExecAdvisory(normalized.legacyGatewayExecJobs),
  ]) {
    if (advisory) {
      note(advisory, "Cron");
    }
  }
  const previewLines = formatLegacyIssuePreview(normalized.issues);
  if (normalized.legacyTriggerScriptJobs.length > 0) {
    previewLines.push(
      `- ${pluralize(normalized.legacyTriggerScriptJobs.length, "legacy cron trigger script")} will be migrated to direct tool calls: ${normalized.legacyTriggerScriptJobs.join(", ")}`,
    );
  }
  previewLines.push(...storagePreviewLines);
  if (notifyCount > 0) {
    previewLines.push(
      `- ${pluralize(notifyCount, "job")} still uses legacy \`notify: true\` webhook fallback`,
    );
  }
  if (previewLines.length === 0) {
    return;
  }

  const noteHeading = `Cron store issues detected at ${shortenHomePath(resolveOpenClawStateSqlitePath())}.`;

  note(
    [
      noteHeading,
      ...previewLines,
      `Repair with ${formatCliCommand("openclaw doctor --fix")} to normalize the store before the next scheduler run.`,
    ].join("\n"),
    "Cron",
  );

  await repair(normalized);
}
