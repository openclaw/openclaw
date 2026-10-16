import fs from "node:fs/promises";
import { isPathInside } from "@openclaw/fs-safe/path";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { discoverBackupDatabasePaths } from "../infra/backup-sqlite-snapshot.js";
import { ensureSqliteLibrarySelected } from "../infra/bun-sqlite-library.js";
import {
  listDatabaseEngineStores,
  resolveDatabaseFamilyEngines,
  selectDatabaseEngine,
} from "../infra/database-engine/registry.js";
import { statePortProvider } from "../infra/database-engine/state-port.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { readBackupEngine, type BackupEngine } from "../snapshot/database-backup.js";

type StateRoot = { path: string; physical: BackupEngine };

async function inspectDatabaseEngines(
  cfg: OpenClawConfig,
  options: { env?: NodeJS.ProcessEnv },
): Promise<{ stateRoots: StateRoot[]; findings: HealthFinding[] }> {
  const env = options.env ?? process.env;
  const context = { config: cfg, stateDir: resolveStateDir(env), env };
  try {
    const selected = selectDatabaseEngine({ id: "state", postgres: true }, cfg);
    const prepared =
      selected === "postgres"
        ? await (
            await import("../infra/backup-database-discovery.js")
          ).preparePostgresBackupDiscovery(context)
        : undefined;
    const paths = prepared?.paths ?? (await discoverBackupDatabasePaths(context));
    if (paths.length === 0) {
      return { stateRoots: [], findings: [] };
    }
    const roots = await Promise.all(
      (
        prepared?.stateRoots ??
        (await statePortProvider.resolveRoots({
          ...context,
          plugins: resolvePluginMetadataSnapshot(context),
        }))
      ).map((root) =>
        fs.realpath(root).catch((error: unknown) => {
          if (hasErrnoCode(error, "ENOENT")) {
            return root;
          }
          throw error;
        }),
      ),
    );
    const stateRoots = paths
      .filter((file) => roots.some((root) => file === root || isPathInside(root, file)))
      .map((file) => ({ path: file, physical: readBackupEngine(file) }));
    const findings: HealthFinding[] = stateRoots
      .filter(({ physical }) => physical.engine !== selected)
      .map(({ path, physical }) => ({
        checkId: "core/doctor/database-engine",
        severity: "warning",
        source: "doctor",
        path,
        message: `Shared state root ${path}: physical=${physical.engine}, configured=${selected} (engine mismatch).`,
        fixHint: `Restore the matching state-family engine setting, or stop the Gateway and use openclaw database port --to ${selected} with a supported engine configuration.`,
      }));
    return { stateRoots, findings };
  } catch {
    return {
      stateRoots: [],
      findings: [
        {
          checkId: "core/doctor/database-engine",
          severity: "warning",
          source: "doctor",
          path: "database.families.state.engine",
          message: "Shared state roots could not be inspected.",
          fixHint:
            "Verify the selected database connection and installed plugin inventory, then rerun openclaw doctor.",
        },
      ],
    };
  }
}

export function collectDatabaseEngineHealthFindings(cfg: OpenClawConfig): HealthFinding[] {
  if (!Object.values(resolveDatabaseFamilyEngines(cfg)).includes("postgres")) {
    return [];
  }
  return [
    {
      checkId: "core/doctor/database-engine",
      severity: "warning",
      source: "doctor",
      path: "database.engine",
      message:
        "The PostgreSQL database engine is experimental. Stores without a registered PostgreSQL schema remain on SQLite.",
      fixHint:
        "Review the store engine selections and https://docs.openclaw.ai/reference/database-engines before using this configuration.",
    },
  ];
}

export async function collectStateRootDatabaseEngineHealthFindings(
  cfg: OpenClawConfig,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<HealthFinding[]> {
  return (await inspectDatabaseEngines(cfg, options)).findings;
}

export async function noteDatabaseEngines(
  cfg: OpenClawConfig,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<HealthFinding[]> {
  const { stateRoots, findings } = await inspectDatabaseEngines(cfg, options);
  findings.push(...collectDatabaseEngineHealthFindings(cfg));
  const defaultEngine = cfg.database?.engine ?? "sqlite";
  const lines = listDatabaseEngineStores().map((store) => {
    const { id } = store;
    const local = id === "quarantine" || id === "managed-update" || id === "package-activation";
    const override = local ? "fixed local" : (cfg.database?.families?.[id]?.engine ?? "inherit");
    return `${store.label}: default=${defaultEngine}, override=${override}, effective=${selectDatabaseEngine(store, cfg)} (configured)`;
  });
  for (const { path, physical } of stateRoots) {
    const namespace = physical.engine === "postgres" ? `, namespace=${physical.namespace}` : "";
    lines.push(`Shared state root: ${path} (physical=${physical.engine}${namespace})`);
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
    lines.push("", finding.message, finding.fixHint ?? "");
  }
  note(lines.join("\n"), "Database engines");
  return findings;
}
