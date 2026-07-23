/** Doctor-owned migration from workspace HEARTBEAT.md files into cron job scratch. */
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { DEFAULT_HEARTBEAT_FILENAME } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatMonitorSpecs } from "../cron/heartbeat-monitor.js";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../cron/scratch-contract.js";
import {
  hashCronScratchSource,
  readCronJobScratchState,
  writeCronJobScratch,
} from "../cron/scratch-store.js";
import { CronService } from "../cron/service.js";
import {
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePath,
} from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { isPathInside } from "../infra/path-guards.js";
import { readRegularFile } from "../infra/regular-file.js";
import { shortenHomePath } from "../utils.js";

const HEARTBEAT_SCRATCH_MIGRATION_CHECK_ID = "core/doctor/heartbeat-scratch-migration";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type HeartbeatScratchMigrationResult = {
  changes: string[];
  warnings: string[];
};

type HeartbeatSource = {
  path: string;
  content: string;
  sha256: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readHeartbeatSource(
  cfg: OpenClawConfig,
  agentId: string,
): Promise<HeartbeatSource | undefined> {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const heartbeatPath = path.join(workspaceDir, DEFAULT_HEARTBEAT_FILENAME);
  let sourceStat;
  try {
    sourceStat = await fs.lstat(heartbeatPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!sourceStat.isFile() && !sourceStat.isSymbolicLink()) {
    throw new Error("HEARTBEAT.md must be a regular file or contained symlink");
  }
  if (sourceStat.isFile() && sourceStat.nlink > 1) {
    throw new Error("HEARTBEAT.md has multiple hard links; refusing automatic removal");
  }

  const workspaceRealPath = await fs.realpath(workspaceDir);
  const sourceRealPath = await fs.realpath(heartbeatPath);
  if (sourceRealPath !== workspaceRealPath && !isPathInside(workspaceRealPath, sourceRealPath)) {
    throw new Error("HEARTBEAT.md symlink target escapes the agent workspace");
  }
  const file = await readRegularFile({
    filePath: sourceRealPath,
    maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
  });
  let content: string;
  try {
    content = utf8Decoder.decode(file.buffer);
  } catch {
    throw new Error("HEARTBEAT.md is not valid UTF-8");
  }
  return {
    path: heartbeatPath,
    content,
    sha256: hashCronScratchSource(content),
  };
}

function createDoctorCronService(storePath: string, cfg: OpenClawConfig): CronService {
  const noop = () => {};
  const log = { debug: noop, info: noop, warn: noop, error: noop };
  return new CronService({
    storePath,
    cronEnabled: false,
    cronConfig: cfg.cron,
    defaultAgentId: resolveDefaultAgentId(cfg),
    log,
    enqueueSystemEvent: () => false,
    requestHeartbeat: noop,
    runIsolatedAgentJob: async () => ({
      status: "skipped",
      error: "doctor does not execute cron jobs",
    }),
  });
}

async function ensureHeartbeatMonitorJobs(
  cfg: OpenClawConfig,
  storePath: string,
): Promise<Map<string, CronJob>> {
  const cron = createDoctorCronService(storePath, cfg);
  const jobs = await cron.list({ includeDisabled: true });
  const specs = resolveHeartbeatMonitorSpecs(cfg, jobs);
  const monitors = new Map<string, CronJob>();
  for (const spec of specs) {
    const result = await cron.add(spec.input, {
      enabledExplicit: true,
      systemOwned: true,
      matchesExisting: (job) => job.payload.kind === "heartbeat",
    });
    const job = "job" in result ? result.job : result;
    monitors.set(spec.agentId, job);
  }
  return monitors;
}

function archivePathForSource(agentId: string, sha256: string, env: NodeJS.ProcessEnv): string {
  const safeAgentId = agentId.replace(/[^A-Za-z0-9._-]+/g, "-");
  return path.join(
    resolveStateDir(env),
    "backups",
    "heartbeat-migration",
    `${safeAgentId}-${sha256}.md`,
  );
}

async function archiveAndRemoveSource(params: {
  cfg: OpenClawConfig;
  agentId: string;
  source: HeartbeatSource;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const archivePath = archivePathForSource(params.agentId, params.source.sha256, params.env);
  await fs.mkdir(path.dirname(archivePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(archivePath, params.source.content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existing = await fs.readFile(archivePath, "utf8");
    if (hashCronScratchSource(existing) !== params.source.sha256) {
      throw new Error(`heartbeat migration archive collision at ${archivePath}`, { cause: error });
    }
  }
  const current = await readHeartbeatSource(params.cfg, params.agentId);
  if (!current || current.sha256 !== params.source.sha256) {
    throw new Error("HEARTBEAT.md changed after scratch was committed; leaving it in place");
  }
  await fs.unlink(params.source.path);
}

function migrationFinding(params: {
  agentId: string;
  path: string;
  requirement: string;
  message: string;
  severity?: HealthFinding["severity"];
}): HealthFinding {
  return {
    checkId: HEARTBEAT_SCRATCH_MIGRATION_CHECK_ID,
    severity: params.severity ?? "warning",
    message: params.message,
    path: params.path,
    target: params.agentId,
    requirement: params.requirement,
    fixHint: `Run ${formatCliCommand("openclaw doctor --fix")} to migrate HEARTBEAT.md into cron scratch.`,
  };
}

/** Reports remaining workspace heartbeat files without changing them. */
export async function collectHeartbeatScratchMigrationFindings(
  cfg: OpenClawConfig,
): Promise<readonly HealthFinding[]> {
  const storePath = resolveCronJobsStorePath();
  const existingJobs = (await loadCronJobsStoreWithConfigJobsReadOnly(storePath)).store.jobs;
  const findings: HealthFinding[] = [];
  for (const spec of resolveHeartbeatMonitorSpecs(cfg, existingJobs)) {
    const heartbeatPath = path.join(
      resolveAgentWorkspaceDir(cfg, spec.agentId),
      DEFAULT_HEARTBEAT_FILENAME,
    );
    try {
      const source = await readHeartbeatSource(cfg, spec.agentId);
      if (!source) {
        continue;
      }
      findings.push(
        migrationFinding({
          agentId: spec.agentId,
          path: heartbeatPath,
          requirement: "legacy-heartbeat-file",
          message: `Agent "${spec.agentId}" still stores heartbeat instructions in HEARTBEAT.md.`,
        }),
      );
    } catch (error) {
      findings.push(
        migrationFinding({
          agentId: spec.agentId,
          path: heartbeatPath,
          requirement: "heartbeat-file-migration-blocked",
          severity: "error",
          message: `Agent "${spec.agentId}" HEARTBEAT.md cannot be migrated: ${errorMessage(error)}`,
        }),
      );
    }
  }
  return findings;
}

/** Migrates each enrolled agent's heartbeat file into its stable monitor job. */
export async function maybeMigrateHeartbeatFilesToScratch(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<HeartbeatScratchMigrationResult> {
  const env = params.env ?? process.env;
  const storePath = resolveCronJobsStorePath(undefined, env);
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!params.shouldRepair) {
    const existingJobs = (await loadCronJobsStoreWithConfigJobsReadOnly(storePath)).store.jobs;
    for (const spec of resolveHeartbeatMonitorSpecs(params.cfg, existingJobs)) {
      try {
        const source = await readHeartbeatSource(params.cfg, spec.agentId);
        if (source) {
          note(
            `${shortenHomePath(source.path)} will migrate into scratch for Heartbeat (${spec.agentId}).`,
            "Heartbeat migration preview",
          );
        }
      } catch (error) {
        warnings.push(
          `Agent "${spec.agentId}" HEARTBEAT.md cannot be migrated: ${errorMessage(error)}`,
        );
      }
    }
    if (warnings.length > 0) {
      note(warnings.join("\n"), "Doctor warnings");
    }
    return { changes, warnings };
  }

  let monitors: Map<string, CronJob>;
  try {
    monitors = await ensureHeartbeatMonitorJobs(params.cfg, storePath);
  } catch (error) {
    return {
      changes,
      warnings: [`Could not prepare heartbeat monitor jobs: ${errorMessage(error)}`],
    };
  }

  for (const [agentId, monitor] of monitors) {
    let source: HeartbeatSource | undefined;
    try {
      source = await readHeartbeatSource(params.cfg, agentId);
    } catch (error) {
      warnings.push(`Agent "${agentId}" HEARTBEAT.md was not migrated: ${errorMessage(error)}`);
      continue;
    }
    if (!source) {
      continue;
    }
    const state = readCronJobScratchState(storePath, monitor.id, { env });
    const current = state.scratch;
    if (current && current.content !== source.content && current.sourceSha256 !== source.sha256) {
      warnings.push(
        `Agent "${agentId}" already has different cron scratch; ${shortenHomePath(source.path)} was left unchanged.`,
      );
      continue;
    }
    try {
      if (current?.sourceSha256 !== source.sha256) {
        const write = writeCronJobScratch({
          storePath,
          jobId: monitor.id,
          content: source.content,
          expectedRevision: state.currentRevision,
          sourceSha256: source.sha256,
          options: { env },
        });
        if (!write.ok) {
          warnings.push(
            `Agent "${agentId}" scratch changed during migration; ${shortenHomePath(source.path)} was left unchanged.`,
          );
          continue;
        }
      }
      const verified = readCronJobScratchState(storePath, monitor.id, { env }).scratch;
      if (
        !verified ||
        verified.content !== source.content ||
        verified.sourceSha256 !== source.sha256
      ) {
        throw new Error("scratch verification failed after write");
      }
      await archiveAndRemoveSource({ cfg: params.cfg, agentId, source, env });
      changes.push(
        `Migrated ${shortenHomePath(source.path)} into cron scratch for ${monitor.displayName ?? monitor.name}.`,
      );
    } catch (error) {
      warnings.push(
        `Agent "${agentId}" scratch was not finalized: ${errorMessage(error)}. Rerun doctor to retry safely.`,
      );
    }
  }

  if (changes.length > 0) {
    note(changes.join("\n"), "Doctor changes");
  }
  if (warnings.length > 0) {
    note(warnings.join("\n"), "Doctor warnings");
  }
  return { changes, warnings };
}
