import { note } from "../../packages/terminal-core/src/note.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { ensureSqliteLibrarySelected } from "../infra/bun-sqlite-library.js";
import { formatDatabaseStoreDiagnostic } from "../infra/database-engine/diagnostics-format.js";
import { describeDatabaseEngineSelection } from "../infra/database-engine/report.js";
import { findSqlitePathsOnNetworkFilesystems } from "../infra/sqlite-wal-filesystem.js";
import type {
  DoctorDatabaseEngineInspection,
  ObservedDatabaseEngines,
} from "./doctor-database-engine-inspection.js";
type InspectionOptions = { env?: NodeJS.ProcessEnv };

function collectDatabaseEngineHealthFindings(
  cfg: OpenClawConfig,
  observed: ObservedDatabaseEngines = {},
): HealthFinding[] {
  const families = describeDatabaseEngineSelection(cfg);
  const findings: HealthFinding[] = [];
  for (const family of families) {
    if (observed[family.id]?.some((engine) => engine !== family.effective)) {
      findings.push({
        checkId: "core/doctor/database-engine",
        severity: "warning",
        source: "doctor",
        path: family.fixedLocal ? "database" : `database.families.${family.id}.engine`,
        message: `${family.label}: configured ${family.effective}, observed ${observed[family.id]!.join(" and ")}. Changing configuration does not migrate existing data.`,
        fixHint: family.fixedLocal
          ? "Restore the local SQLite safety store from its verified backup."
          : `Keep the Gateway stopped and use openclaw database port --family ${family.id} to migrate this family, or restore its matching engine selection.`,
      });
    }
  }
  return findings;
}

function stateRootFindings(
  cfg: OpenClawConfig,
  inspection: DoctorDatabaseEngineInspection,
): HealthFinding[] {
  const selected = describeDatabaseEngineSelection(cfg).find(
    (family) => family.id === "state",
  )!.effective;
  const findings: HealthFinding[] = inspection.stateRoots
    .filter(({ physical }) => physical.engine !== selected)
    .map(({ path, physical }) => ({
      checkId: "core/doctor/database-engine",
      severity: "warning",
      source: "doctor",
      path,
      message: `Shared state root ${path}: physical=${physical.engine}, configured=${selected} (engine mismatch).`,
      fixHint: `Restore the matching state-family engine setting, or stop the Gateway and use openclaw database port --family state --to ${selected}.`,
    }));
  if (inspection.discoveryFailed) {
    findings.push({
      checkId: "core/doctor/database-engine",
      severity: "warning",
      source: "doctor",
      path: "database.families.state.engine",
      message: "Database roots could not all be inspected.",
      fixHint:
        "Verify the selected database connection and installed plugin inventory, then rerun openclaw doctor.",
    });
  }
  return findings;
}

async function inspect(cfg: OpenClawConfig, options: InspectionOptions) {
  const { inspectDoctorDatabaseEngines } = await import("./doctor-database-engine-inspection.js");
  const env = options.env ?? process.env;
  return inspectDoctorDatabaseEngines({ config: cfg, stateDir: resolveStateDir(env), env });
}

function collectInspectionFindings(
  cfg: OpenClawConfig,
  inspection: DoctorDatabaseEngineInspection,
) {
  // State mismatches retain their precise physical paths instead of a duplicate family warning.
  const observed = { ...inspection.observed, state: undefined };
  const sqlitePaths = (inspection.stores ?? []).flatMap((store) =>
    store.path &&
    (store.observed === "sqlite" ||
      (store.observed === "unknown" && store.configured.effective === "sqlite"))
      ? [store.path]
      : [],
  );
  return [
    ...collectDatabaseEngineHealthFindings(cfg, observed),
    ...stateRootFindings(cfg, inspection),
    ...findSqlitePathsOnNetworkFilesystems(sqlitePaths).map((path): HealthFinding => ({
      checkId: "core/doctor/database-engine",
      severity: "warning",
      source: "doctor",
      path,
      message: `SQLite path ${path} is on a network filesystem, where WAL can cause corruption. OpenClaw uses rollback journaling on supported network filesystems.`,
      fixHint:
        "Stop the Gateway, back up the state, and move the state directory and any custom database paths to a local disk before restarting.",
    })),
    ...(inspection.stores ?? []).map((store): HealthFinding => ({
      checkId: "core/doctor/database-engine",
      severity: store.issues.length || store.legacyMigrations.state !== "none" ? "warning" : "info",
      source: "doctor",
      target: store.path ?? store.family,
      path: store.path ?? `database.families.${store.family}`,
      message: formatDatabaseStoreDiagnostic(store),
      fixHint: store.nextSteps.join(" ") || undefined,
      details: { ...store },
    })),
  ];
}

export async function collectDoctorDatabaseEngineHealthFindings(
  cfg: OpenClawConfig,
  options: InspectionOptions = {},
): Promise<HealthFinding[]> {
  return collectInspectionFindings(cfg, await inspect(cfg, options));
}

export async function noteDatabaseEngines(
  cfg: OpenClawConfig,
  options: InspectionOptions = {},
): Promise<HealthFinding[]> {
  const inspection = await inspect(cfg, options);
  const findings = collectInspectionFindings(cfg, inspection);
  const lines = describeDatabaseEngineSelection(cfg).map((family) => {
    const override = family.fixedLocal ? "fixed local" : (family.override ?? "inherit");
    const physical = inspection.observed[family.id]?.length
      ? `; observed=${inspection.observed[family.id]!.join(",")}`
      : "";
    return `${family.label}: default=${family.default}, override=${override}, effective=${family.effective} (configured)${physical}`;
  });
  for (const { path, physical } of inspection.stateRoots) {
    const namespace = physical.engine === "postgres" ? `, namespace=${physical.namespace}` : "";
    lines.push(`Shared state root: ${path} (physical=${physical.engine}${namespace})`);
  }
  for (const store of inspection.stores ?? []) {
    lines.push(formatDatabaseStoreDiagnostic(store));
  }
  const sqliteLibrary = ensureSqliteLibrarySelected();
  if (sqliteLibrary.source !== "runtime") {
    lines.push(
      `SQLite (doctor process): ${sqliteLibrary.path} (${sqliteLibrary.version}, extension loading enabled)`,
    );
  } else if (sqliteLibrary.ignoredOverride) {
    lines.push(`SQLite (doctor process): ${sqliteLibrary.ignoredOverride}; override ignored`);
  }
  for (const finding of findings) {
    if (finding.details) {
      continue;
    }
    lines.push("", finding.message, finding.fixHint ?? "");
  }
  note(lines.join("\n"), "Database engines");
  return findings;
}
