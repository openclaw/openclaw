// Core command handlers for SQLite snapshot artifacts.
import { promises as fs } from "node:fs";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { createLocalSqliteSnapshotProvider } from "../snapshot/local-repository.js";
import type {
  SnapshotManifest,
  SnapshotSummary,
  SnapshotVerificationResult,
} from "../snapshot/snapshot-provider.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

export interface SnapshotCreateOptions {
  readonly db?: string;
  readonly target?: string;
  readonly agent?: string;
  readonly repository?: string;
  readonly id?: string;
  readonly kind?: string;
  readonly json?: boolean;
}

export interface SnapshotRepositoryOptions {
  readonly repository?: string;
  readonly json?: boolean;
}

export interface SnapshotJsonOptions {
  readonly json?: boolean;
}

export interface SnapshotRestoreOptions extends SnapshotJsonOptions {
  readonly target?: string;
}

type SnapshotCreateReport = {
  readonly ok: true;
  readonly snapshotPath: string;
  readonly manifest: SnapshotManifest;
};

type SnapshotVerifyReport = SnapshotVerificationResult & {
  readonly snapshotPath: string;
};

type SnapshotRestoreReport = SnapshotVerificationResult & {
  readonly snapshotPath: string;
  readonly targetPath: string;
};

type SnapshotListReport = {
  readonly ok: true;
  readonly snapshots: readonly SnapshotSummary[];
};

type SnapshotCreateSource = {
  readonly path: string;
  readonly id?: string;
  readonly kind?: string;
  readonly sanitize?: "global-state";
};

export async function snapshotCreateCommand(
  options: SnapshotCreateOptions,
  runtime: RuntimeEnv,
): Promise<number> {
  try {
    const repositoryPath = requireOption(options.repository, "--repository");
    const source = await resolveSnapshotCreateSource(options);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const result = await provider.create({
      path: source.path,
      ...(source.id ? { id: source.id } : {}),
      ...(source.kind ? { kind: source.kind } : {}),
      ...(source.sanitize ? { sanitize: source.sanitize } : {}),
    });
    writeCreateReport(
      { ok: true, snapshotPath: result.ref.path, manifest: result.manifest },
      options,
      runtime,
    );
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function snapshotVerifyCommand(
  snapshotPath: string,
  options: SnapshotJsonOptions,
  runtime: RuntimeEnv,
): Promise<number> {
  try {
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath: "." });
    const verified = await provider.verify({ path: requireValue(snapshotPath, "<snapshot>") });
    writeVerifyReport({ ...verified, snapshotPath }, options, runtime);
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function snapshotRestoreCommand(
  snapshotPath: string,
  options: SnapshotRestoreOptions,
  runtime: RuntimeEnv,
): Promise<number> {
  try {
    const targetPath = requireOption(options.target, "--target");
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath: "." });
    const verified = await provider.restore(
      { path: requireValue(snapshotPath, "<snapshot>") },
      targetPath,
    );
    writeRestoreReport({ ...verified, snapshotPath, targetPath }, options, runtime);
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function snapshotListCommand(
  options: SnapshotRepositoryOptions,
  runtime: RuntimeEnv,
): Promise<number> {
  try {
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath: requireOption(options.repository, "--repository"),
    });
    writeListReport({ ok: true, snapshots: (await provider.list?.()) ?? [] }, options, runtime);
    return 0;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

async function resolveSnapshotCreateSource(
  options: SnapshotCreateOptions,
): Promise<SnapshotCreateSource> {
  if (!hasValue(options.db) && !hasValue(options.target) && !hasValue(options.agent)) {
    throw new Error(
      "Missing snapshot source. Provide one of --db <path>, --target global, or --agent <id>.",
    );
  }
  if (hasValue(options.db) && (hasValue(options.target) || hasValue(options.agent))) {
    throw new Error("Choose only one snapshot source: --db, --target, or --agent.");
  }
  if (hasValue(options.db)) {
    return {
      path: await realpathIfExists(requireValue(options.db, "--db")),
      ...(options.id ? { id: options.id } : {}),
      ...(options.kind ? { kind: options.kind } : {}),
    };
  }
  if (hasValue(options.target)) {
    const target = requireValue(options.target, "--target").toLowerCase();
    if (target === "global") {
      if (hasValue(options.agent)) {
        throw new Error("--agent cannot be combined with --target global.");
      }
      return {
        path: await realpathIfExists(resolveOpenClawStateSqlitePath()),
        id: options.id ?? "global",
        kind: options.kind ?? "global-control-plane",
        sanitize: "global-state",
      };
    }
    throw new Error(`Unsupported snapshot target "${target}". Supported targets: global.`);
  }
  const agentId = normalizeAgentId(requireValue(options.agent, "--agent"));
  return {
    path: await realpathIfExists(resolveOpenClawAgentSqlitePath({ agentId })),
    id: options.id ?? `agent:${agentId}`,
    kind: options.kind ?? "agent-data-plane",
  };
}

async function realpathIfExists(databasePath: string): Promise<string> {
  return await fs.realpath(databasePath).catch(() => databasePath);
}

function writeCreateReport(
  report: SnapshotCreateReport,
  options: SnapshotJsonOptions,
  runtime: RuntimeEnv,
): void {
  if (options.json === true) {
    writeJson(report, runtime);
    return;
  }
  runtime.log(
    `snapshot create: ${report.snapshotPath} (${report.manifest.database.id}, ${report.manifest.artifact.sizeBytes} bytes)`,
  );
}

function writeVerifyReport(
  report: SnapshotVerifyReport,
  options: SnapshotJsonOptions,
  runtime: RuntimeEnv,
): void {
  if (options.json === true) {
    writeJson(report, runtime);
    return;
  }
  runtime.log(
    `snapshot verify: ok (${report.manifest.database.id}, ${report.manifest.artifact.sizeBytes} bytes)`,
  );
}

function writeRestoreReport(
  report: SnapshotRestoreReport,
  options: SnapshotJsonOptions,
  runtime: RuntimeEnv,
): void {
  if (options.json === true) {
    writeJson(report, runtime);
    return;
  }
  runtime.log(`snapshot restore: ${report.targetPath} (${report.manifest.database.id})`);
}

function writeListReport(
  report: SnapshotListReport,
  options: SnapshotJsonOptions,
  runtime: RuntimeEnv,
): void {
  if (options.json === true) {
    writeJson(report, runtime);
    return;
  }
  if (report.snapshots.length === 0) {
    runtime.log("snapshot list: no snapshots");
    return;
  }
  for (const snapshot of report.snapshots) {
    runtime.log(
      `${snapshot.manifest.createdAt} ${snapshot.manifest.database.id} ${snapshot.ref.path}`,
    );
  }
}

function writeJson(value: unknown, runtime: RuntimeEnv): void {
  writeRuntimeJson(runtime, value, 0);
}

function requireOption(value: string | undefined, flag: string): string {
  return requireValue(value, flag);
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function requireValue(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required ${label} value.`);
  }
  return value;
}
