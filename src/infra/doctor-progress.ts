// Core-owned labels may cross a delegated Doctor's diagnostic boundary. Plugin
// and config-derived labels remain private to the child and its captured output.
const CORE_PHASES = [
  "doctor.startup",
  "doctor.maintenance-admission",
  "doctor.archive-preparation",
  "doctor.maintenance.begin",
  "doctor.state-preflight",
  "doctor.database-preflight",
  "doctor.schema-admission",
  "doctor.state-database-repair",
  "doctor.state-schema",
  "doctor.config-flow",
  "doctor.database-migrations",
  "doctor.heartbeat-migration-backups",
  "doctor.contributions",
  "doctor.external-config",
  "doctor.maintenance-ready",
  "doctor.sqlite-nocow",
  "doctor.sqlite-reclamation",
  "doctor.retained-runtimes",
  "doctor.maintenance.finish",
  "doctor.maintenance.release",
  "Update schema admission",
  "Update schema rehearsal",
  "Agent deletion journal",
  "Database preflight",
  "UI protocol",
  "Source install",
  "CLI launcher",
  "Plugin runtime links",
  "Config repairs",
  "Preserve original state",
] as const;

export type DoctorProgressPhase = (typeof CORE_PHASES)[number];
export type DoctorProgressMeasure = <T>(
  phase: DoctorProgressPhase,
  run: () => T | Promise<T>,
) => Promise<T>;

export function formatDoctorProgressPhase(phase: DoctorProgressPhase): string {
  return phase.replace(/^doctor\./u, "").replaceAll(/[.-]/gu, " ");
}

const CORE_LABELS = new Set(CORE_PHASES.map(formatDoctorProgressPhase));

// Only core-owned reasons may leave the child; plugin/config values are not diagnostics.
const RETIREMENT_WIDENING =
  /^Retirement-only Doctor widened: (?:config\.(?:model-retirement(?:\.(?:pending-changes|change-notes|warning-notes(?:\.codex-routes)?|auth-findings|model-replacements|model-repair-warnings))?|config-repair|config-missing|config-invalid|legacy-write-blocked|heartbeat-deferred|preflight-unsettled|preflight-config-changed|state-migration-unsettled|cron-selection-unresolved|heartbeat-migration|billing-migration|repair-warning|mutable-allowlist-warning|plugin-warning|billing-warning|plugin-inventory-changed|channel-work|provider-renames|blocked-models|phone-cleanup|session-plan-unbound|session-plan-refused|preparation)|agent-admission|startup-findings|startup-warnings|doctor:(?:write-config-migrations|auth-profile-migration|session-transcripts|codex-session-routes|write-config|final-config-validation)(?:\.failed)?)$/u;

export function parseDoctorRetirementWideningLine(line: string): string | undefined {
  return RETIREMENT_WIDENING.test(line) ? line : undefined;
}

/** Reconstruct only bounded core facts, never arbitrary child diagnostic text. */
export function parseDoctorProgressLine(line: string): string | undefined {
  if (line.length > 128) {
    return undefined;
  }
  const match = /^Doctor: ([A-Za-z ]+)( \(\d{1,10}s elapsed\))?$/u.exec(line);
  return match?.[1] && CORE_LABELS.has(match[1])
    ? `Doctor: ${match[1]}${match[2] ?? ""}`
    : undefined;
}
