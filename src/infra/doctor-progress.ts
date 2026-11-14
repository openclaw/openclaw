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
