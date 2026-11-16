import { truncateUtf16Safe, truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { resolveStateDir } from "../config/paths.js";
import { redactKnownPathPrefixesForSupport } from "../logging/diagnostic-support-redaction.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatStateLeaseLoss } from "../shared/state-lease-loss-format.js";
import {
  listAgentDatabaseAdmissionRefusals,
  listAgentDatabaseStartupFtsRepairs,
} from "../state/agent-database-admission.js";
import { shortenHomeInString } from "../utils.js";
import type {
  LegacyStateMigrationStepPlan,
  LegacyStateMigrationStepReceipt,
  MigrationLogger,
  MigrationMessages,
} from "./state-migrations.types.js";
import { normalizeUpdateFailureFacts, type UpdateFailureFact } from "./update-failure-facts.js";

type NoticeSource = { notices?: readonly string[] } | undefined;

const STARTUP_MIGRATION_FOLLOW_UP =
  'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.';

/** Matches the persisted failure-fact bound; extra refusals stay in the log. */
const MAX_REFUSAL_DETAILS = 5;

/** A required migration that a read-only Doctor run leaves for `--fix`, not broken state. */
export const PENDING_STATE_MIGRATION_REFUSAL_CODE = "state-migration-pending";

/**
 * Doctor writes this text to the operator's terminal, so it keeps the local path
 * (home/state-labelled) that support reports redact. Secrets still do not survive.
 */
function formatLocalMigrationDetail(value: string): string {
  const line = value.split(/[\r\n\u2028\u2029]/u).find((entry) => entry.trim()) ?? "";
  if (!line) {
    return "";
  }
  const env = process.env;
  // `~` is the operator's own home; a state dir outside it keeps the canonical label.
  const homeRelative = shortenHomeInString(redactSensitiveText(line, { mode: "tools" }));
  return truncateUtf16Safe(
    sanitizeTerminalText(
      redactKnownPathPrefixesForSupport(homeRelative, {
        env,
        stateDir: resolveStateDir(env),
      }),
    ),
    400,
  );
}

function formatLocalRefusalLine(receipt: LegacyStateMigrationStepReceipt): string | undefined {
  const refusal = receipt.refusal;
  if (!refusal) {
    return undefined;
  }
  const message = formatLocalMigrationDetail(refusal.message);
  return `Failing check ${receipt.id} (${refusal.code})${message ? `: ${message}` : ""}${receipt.leaseLoss ? `; ${formatStateLeaseLoss(receipt.leaseLoss)}` : ""}`;
}

export function formatStartupMigrationFailure(errors: readonly string[]): string {
  return [
    "OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.",
    ...errors.map((error) => `- ${error}`),
    STARTUP_MIGRATION_FOLLOW_UP,
  ].join("\n");
}

let startupMigrationDetails: string | undefined;

function formatStartupMigrationDetails(warnings: readonly string[]): string {
  return sanitizeTerminalText(
    redactSensitiveText([...new Set(warnings)].map((warning) => `- ${warning}`).join("\n"), {
      mode: "tools",
    }),
  );
}

function boundStartupMigrationDetails(details: string): string {
  return truncateWithMarker(details, 2000, {
    marker: "… (see startup log)",
    reserve: 20,
    trimEnd: true,
  });
}

/** The running Gateway owns this boot fact; status and Doctor must not rerun migrations to infer it. */
export function recordStartupMigrationWarnings(warnings: readonly string[]): void {
  if (warnings.length === 0) {
    return;
  }
  const details = formatStartupMigrationDetails(warnings);
  // Keep this boot fact until restart: a repeated preflight can skip already-checked migrations.
  // Bound model-visible diagnostics; the startup log retains the full redacted report.
  const summary = boundStartupMigrationDetails(details);
  if (startupMigrationDetails !== summary) {
    startupMigrationDetails = summary;
    createSubsystemLogger("state-migrations").warn(
      `Startup migration warnings; continuing with degraded state.\n${details}\n${STARTUP_MIGRATION_FOLLOW_UP}`,
    );
  }
}

export function readStartupMigrationWarning(includeSensitive = true): string | undefined {
  // Admission owns preparation outcomes; pending work is not a retained migration failure.
  const admissionWarnings = listAgentDatabaseAdmissionRefusals()
    .filter((refusal) => refusal.code !== "agent-database-inspection-pending")
    .map((refusal) => `${refusal.reason}\n${refusal.repairHint}`);
  const repairs = listAgentDatabaseStartupFtsRepairs();
  const needsAttention = Boolean(startupMigrationDetails || admissionWarnings.length);
  const details = [
    startupMigrationDetails,
    formatStartupMigrationDetails([...admissionWarnings, ...repairs]),
  ]
    .filter(Boolean)
    .join("\n");
  if (!details) {
    return undefined;
  }
  // Migration errors can contain host paths; read-only status keeps only the repair hint.
  return includeSensitive
    ? `${boundStartupMigrationDetails(details)}${needsAttention ? `\n${STARTUP_MIGRATION_FOLLOW_UP}` : ""}`
    : needsAttention
      ? `Startup migrations need attention. ${STARTUP_MIGRATION_FOLLOW_UP}`
      : "Startup rebuilt stale search indexes; see startup log.";
}

export function mergeNotices(sources: NoticeSource[]): string[] {
  return [...new Set(sources.flatMap((source) => (source?.notices ? [...source.notices] : [])))];
}

export function createLegacyStateMigrationStepReceipt(
  step: Omit<LegacyStateMigrationStepPlan, "outcome">,
  result: MigrationMessages,
): LegacyStateMigrationStepReceipt {
  const refused = result.warnings.length > 0 && result.warningDisposition !== "recoverable";
  return {
    ...step,
    outcome: refused
      ? "refused"
      : result.outcome
        ? result.outcome
        : result.warnings.length > 0
          ? "warning"
          : result.changes.length > 0
            ? "completed"
            : "skipped",
    changes: result.changes,
    warnings: result.warnings,
    ...(result.leaseLoss ? { leaseLoss: result.leaseLoss } : {}),
    ...(result.deferred?.length ? { deferred: result.deferred } : {}),
    ...(result.sqliteFamilies?.length ? { sqliteFamilies: result.sqliteFamilies } : {}),
    ...(result.refusedAgentDatabasePaths?.length
      ? { refusedAgentDatabasePaths: result.refusedAgentDatabasePaths }
      : {}),
    ...(result.recoveredAgentDatabasePaths?.length
      ? { recoveredAgentDatabasePaths: result.recoveredAgentDatabasePaths }
      : {}),
    ...(result.notices?.length ? { notices: result.notices } : {}),
    ...(result.rehearsal ? { rehearsal: result.rehearsal } : {}),
    ...(refused
      ? {
          refusal: step.refusal ?? {
            code: result.refusedAgentDatabasePaths?.length
              ? "agent-database-ownership-mismatch"
              : "step-refused",
            message: result.warnings.join("\n"),
          },
        }
      : {}),
  };
}

export class DoctorStateMigrationRefusalError extends Error {
  readonly stepReceipts: readonly LegacyStateMigrationStepReceipt[];
  readonly failureFacts: UpdateFailureFact[];

  constructor(stepReceipts: readonly LegacyStateMigrationStepReceipt[]) {
    const refused = stepReceipts.filter((receipt) => receipt.outcome === "refused");
    const isBlocked = (receipt: LegacyStateMigrationStepReceipt) =>
      receipt.refusal?.code === "blocked-by-prior-refusal" ||
      receipt.refusal?.code === "blocked-by-agent-database-refusal";
    const orderedRefusals = refused.toSorted(
      (left, right) => Number(isBlocked(left)) - Number(isBlocked(right)),
    );
    const failureFacts = normalizeUpdateFailureFacts(
      orderedRefusals.flatMap((receipt) =>
        receipt.refusal
          ? [
              {
                check: receipt.id,
                code: receipt.refusal.code,
                message: receipt.refusal.message,
                leaseLoss: receipt.leaseLoss,
              },
            ]
          : [],
      ),
    );
    const onlyAgentOwnershipRefusals =
      refused.length > 0 &&
      refused.every(
        (receipt) =>
          receipt.refusal?.code === "agent-database-ownership-mismatch" ||
          receipt.refusal?.code === "blocked-by-agent-database-refusal",
      );
    // A pending migration parks later steps; it is routine work for --fix, not a failed repair.
    const pendingMigrationOnly =
      refused.length > 0 &&
      refused.every(
        (receipt) =>
          receipt.refusal?.code === PENDING_STATE_MIGRATION_REFUSAL_CODE || isBlocked(receipt),
      ) &&
      refused.some((receipt) => receipt.refusal?.code === PENDING_STATE_MIGRATION_REFUSAL_CODE);
    super(
      [
        onlyAgentOwnershipRefusals
          ? "Doctor stopped because an agent database ownership mismatch remains. Independent state repairs were run; repairs requiring the refused database were skipped. Resolve the reported ownership mismatch before retrying."
          : pendingMigrationOnly
            ? 'Doctor found pending state migrations. Run "openclaw doctor --fix" against the same state/config to complete them; later repairs were not run.'
            : "Doctor stopped because a state migration refused to continue. Resolve the reported migration failure before retrying. Later repairs were not run.",
        // Terminal details keep the local cause and path; failureFacts keep support redaction.
        ...orderedRefusals
          .filter((receipt) => receipt.refusal)
          .slice(0, MAX_REFUSAL_DETAILS)
          .flatMap((receipt) => formatLocalRefusalLine(receipt) ?? []),
        // Actionable commands must survive the persisted failure facts' length limit.
        ...mergeNotices(refused).map((notice) => formatStartupMigrationDetails([notice])),
      ].join("\n"),
    );
    this.name = "DoctorStateMigrationRefusalError";
    this.stepReceipts = [...stepReceipts];
    this.failureFacts = failureFacts;
  }
}

/** Call after the writer closes its receipts, never from its per-step callback. */
export function throwIfDoctorStateMigrationRefused(
  stepReceipts: readonly LegacyStateMigrationStepReceipt[] = [],
): void {
  if (stepReceipts.some((receipt) => receipt.outcome === "refused")) {
    throw new DoctorStateMigrationRefusalError(stepReceipts);
  }
}

export function logStateMigrationResult(
  result: MigrationMessages,
  logger: MigrationLogger = createSubsystemLogger("state-migrations"),
): void {
  for (const [key, title, level] of [
    ["changes", "Auto-migrated legacy state", "info"],
    ["warnings", "Legacy state migration warnings", "warn"],
    ["notices", "Legacy state migration notes", "info"],
  ] as const) {
    if (result[key]?.length) {
      logger[level](`${title}:\n${result[key].map((entry) => `- ${entry}`).join("\n")}`);
    }
  }
}
