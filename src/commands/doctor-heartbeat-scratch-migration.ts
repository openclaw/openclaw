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
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { resolveHeartbeatAgents } from "../infra/heartbeat-runner.js";
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
  canonicalPath: string;
  content: string;
  sha256: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readHeartbeatSource(
  cfg: OpenClawConfig,
  agentId: string,
  options?: { recoverClaims?: boolean },
): Promise<HeartbeatSource | undefined> {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const heartbeatPath = path.join(workspaceDir, DEFAULT_HEARTBEAT_FILENAME);
  let sourceStat;
  try {
    sourceStat = await fs.lstat(heartbeatPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // Crash recovery: a killed run can leave the only copy at a claim path
    // after the rename but before scratch release. Surface it here so both
    // findings and repair see the interrupted migration instead of "no file".
    const staleClaim = await findStaleHeartbeatClaim(heartbeatPath);
    if (!staleClaim) {
      return undefined;
    }
    if (!options?.recoverClaims) {
      throw new Error(
        `an interrupted migration claim exists at ${staleClaim}; run openclaw doctor --fix to restore it`,
      );
    }
    await restoreClaimNoClobber(staleClaim, heartbeatPath);
    sourceStat = await fs.lstat(heartbeatPath);
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
    canonicalPath: sourceRealPath,
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

type HeartbeatSourceClaim = {
  claimPath: string;
  restore(cause: unknown): Promise<void>;
  release(): Promise<void>;
};

const HEARTBEAT_CLAIM_INFIX = ".doctor-importing-";

/** Newest interrupted-claim sibling for a missing canonical heartbeat path. */
async function findStaleHeartbeatClaim(heartbeatPath: string): Promise<string | undefined> {
  const dir = path.dirname(heartbeatPath);
  const claimPrefix = `${path.basename(heartbeatPath)}${HEARTBEAT_CLAIM_INFIX}`;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  const claims = entries
    .filter((entry) => entry.startsWith(claimPrefix) && !entry.includes(".conflict-"))
    .toSorted();
  const newest = claims.at(-1);
  return newest ? path.join(dir, newest) : undefined;
}

/**
 * Restore a claim without clobbering: `link` fails with EEXIST when another
 * process recreated the destination while we held the claim, so both files
 * survive (the recreation in place, the claimed original at a conflict path).
 */
async function restoreClaimNoClobber(claimPath: string, destinationPath: string): Promise<void> {
  try {
    await fs.link(claimPath, destinationPath);
    await fs.unlink(claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const conflictPath = `${claimPath}.conflict-${Date.now()}`;
    await fs.rename(claimPath, conflictPath);
    throw new Error(
      `HEARTBEAT.md was recreated during migration; the claimed original is preserved at ${conflictPath}`,
      { cause: error },
    );
  }
}

/**
 * Move the source aside and prove the claimed bytes still match what was read.
 * The claim happens before any scratch write so a concurrent edit can never
 * leave stale content committed while the replacement file is restored.
 */
async function claimHeartbeatSource(source: HeartbeatSource): Promise<HeartbeatSourceClaim> {
  const claimPath = `${source.path}${HEARTBEAT_CLAIM_INFIX}${process.pid}-${source.sha256.slice(0, 12)}`;
  await fs.rename(source.path, claimPath);
  const restore = async (cause: unknown) => {
    await restoreClaimNoClobber(claimPath, source.path).catch((restoreError) => {
      throw restoreError instanceof Error && restoreError.message.includes("preserved at")
        ? restoreError
        : new Error(`HEARTBEAT.md migration claim could not be restored from ${claimPath}`, {
            cause: cause ?? restoreError,
          });
    });
  };
  try {
    const workspaceRealPath = await fs.realpath(path.dirname(source.path));
    const claimRealPath = await fs.realpath(claimPath);
    if (claimRealPath !== workspaceRealPath && !isPathInside(workspaceRealPath, claimRealPath)) {
      throw new Error("claimed HEARTBEAT.md target escapes the agent workspace");
    }
    const claimed = await readRegularFile({
      filePath: claimRealPath,
      maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
    });
    const claimedContent = utf8Decoder.decode(claimed.buffer);
    if (hashCronScratchSource(claimedContent) !== source.sha256) {
      throw new Error("HEARTBEAT.md changed before the migration claim was acquired");
    }
  } catch (error) {
    await restore(error);
    throw error;
  }
  return {
    claimPath,
    restore,
    release: async () => {
      // A holder of an already-open descriptor can still mutate the claimed
      // inode; re-verify the bytes so release never deletes an unseen edit.
      const finalBytes = await readRegularFile({
        filePath: claimPath,
        maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
      });
      if (hashCronScratchSource(utf8Decoder.decode(finalBytes.buffer)) !== source.sha256) {
        const error = new Error("HEARTBEAT.md changed while the migration claim was held");
        await restore(error);
        throw error;
      }
      await fs.unlink(claimPath);
    },
  };
}

async function archiveSource(params: {
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
  const findings: HealthFinding[] = [];
  for (const agent of resolveHeartbeatAgents(cfg)) {
    const heartbeatPath = path.join(
      resolveAgentWorkspaceDir(cfg, agent.agentId),
      DEFAULT_HEARTBEAT_FILENAME,
    );
    try {
      const source = await readHeartbeatSource(cfg, agent.agentId);
      if (!source) {
        continue;
      }
      findings.push(
        migrationFinding({
          agentId: agent.agentId,
          path: heartbeatPath,
          requirement: "legacy-heartbeat-file",
          message: `Agent "${agent.agentId}" still stores heartbeat instructions in HEARTBEAT.md.`,
        }),
      );
    } catch (error) {
      findings.push(
        migrationFinding({
          agentId: agent.agentId,
          path: heartbeatPath,
          requirement: "heartbeat-file-migration-blocked",
          severity: "error",
          message: `Agent "${agent.agentId}" HEARTBEAT.md cannot be migrated: ${errorMessage(error)}`,
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
  const storePath = resolveCronJobsStorePathFromConfig(params.cfg, env);
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!params.shouldRepair) {
    for (const agent of resolveHeartbeatAgents(params.cfg)) {
      try {
        const source = await readHeartbeatSource(params.cfg, agent.agentId);
        if (source) {
          note(
            `${shortenHomePath(source.path)} will migrate into scratch for Heartbeat (${agent.agentId}).`,
            "Heartbeat migration preview",
          );
        }
      } catch (error) {
        warnings.push(
          `Agent "${agent.agentId}" HEARTBEAT.md cannot be migrated: ${errorMessage(error)}`,
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

  // Agents can share one workspace file. Group monitors by source path and
  // import into every monitor before the file is archived and removed once, so
  // the first agent's cleanup cannot starve its siblings.
  const groups = new Map<string, { source: HeartbeatSource; agents: [string, CronJob][] }>();
  for (const [agentId, monitor] of monitors) {
    let source: HeartbeatSource | undefined;
    try {
      source = await readHeartbeatSource(params.cfg, agentId, { recoverClaims: true });
    } catch (error) {
      warnings.push(`Agent "${agentId}" HEARTBEAT.md was not migrated: ${errorMessage(error)}`);
      continue;
    }
    if (!source) {
      continue;
    }
    const group = groups.get(source.canonicalPath) ?? { source, agents: [] };
    group.agents.push([agentId, monitor]);
    groups.set(source.canonicalPath, group);
  }

  for (const { source, agents } of groups.values()) {
    // Precondition pass first: operator-owned scratch (different content or an
    // explicit unset tombstone) blocks the whole group before the file is
    // touched, so nothing is claimed or committed for a source that must stay.
    // The revision seen here is also the CAS token for the later write, so a
    // concurrent edit in between surfaces as a conflict, never an overwrite.
    let blocked = false;
    const plannedRevisionByJobId = new Map<string, number>();
    for (const [agentId, monitor] of agents) {
      const state = readCronJobScratchState(storePath, monitor.id, { env });
      const current = state.scratch;
      plannedRevisionByJobId.set(monitor.id, state.currentRevision);
      if (state.currentRevision > 0 && !current) {
        warnings.push(
          `Agent "${agentId}" scratch was explicitly unset; ${shortenHomePath(source.path)} was left unchanged.`,
        );
        blocked = true;
      } else if (
        current &&
        current.content !== source.content &&
        current.sourceSha256 !== source.sha256
      ) {
        warnings.push(
          `Agent "${agentId}" already has different cron scratch; ${shortenHomePath(source.path)} was left unchanged.`,
        );
        blocked = true;
      }
    }
    if (blocked) {
      continue;
    }

    // Archive before the claim rename: if doctor dies mid-claim, the content is
    // already durable under the state backups instead of only at a hidden
    // .doctor-importing-* path nothing rescans.
    try {
      await archiveSource({ agentId: agents[0]![0], source, env });
    } catch (error) {
      warnings.push(
        `${shortenHomePath(source.path)} was not migrated: ${errorMessage(error)}. Rerun doctor to retry safely.`,
      );
      continue;
    }

    // Claim before committing: once the file is renamed aside and hash-verified,
    // no concurrent editor can change the bytes that reach scratch, and a claim
    // failure restores the file with nothing committed.
    let claim: HeartbeatSourceClaim;
    try {
      claim = await claimHeartbeatSource(source);
    } catch (error) {
      warnings.push(
        `${shortenHomePath(source.path)} was not migrated: ${errorMessage(error)}. Rerun doctor to retry safely.`,
      );
      continue;
    }

    let importedAll = true;
    const groupChanges: string[] = [];
    const committedThisRun: Array<{
      agentId: string;
      monitor: CronJob;
      previous: ReturnType<typeof readCronJobScratchState>["scratch"];
      newRevision: number;
    }> = [];
    for (const [agentId, monitor] of agents) {
      try {
        const state = readCronJobScratchState(storePath, monitor.id, { env });
        if (state.scratch?.sourceSha256 !== source.sha256) {
          const write = writeCronJobScratch({
            storePath,
            jobId: monitor.id,
            content: source.content,
            expectedRevision: plannedRevisionByJobId.get(monitor.id) ?? state.currentRevision,
            sourceSha256: source.sha256,
            options: { env },
          });
          if (!write.ok) {
            throw new Error("scratch changed during migration");
          }
          committedThisRun.push({
            agentId,
            monitor,
            previous: state.scratch,
            newRevision: write.currentRevision,
          });
        }
        const verified = readCronJobScratchState(storePath, monitor.id, { env }).scratch;
        if (
          !verified ||
          verified.content !== source.content ||
          verified.sourceSha256 !== source.sha256
        ) {
          throw new Error("scratch verification failed after write");
        }
        groupChanges.push(
          `Migrated ${shortenHomePath(source.path)} into cron scratch for ${monitor.displayName ?? monitor.name}.`,
        );
      } catch (error) {
        warnings.push(
          `Agent "${agentId}" scratch was not finalized: ${errorMessage(error)}. Rerun doctor to retry safely.`,
        );
        importedAll = false;
      }
    }
    if (!importedAll) {
      // The restored legacy file is authoritative again, so this run's partial
      // scratch imports must revert too — otherwise those agents keep serving
      // the imported copy and ignore later edits to the restored file.
      for (const commit of committedThisRun.toReversed()) {
        const revert = writeCronJobScratch({
          storePath,
          jobId: commit.monitor.id,
          content: commit.previous?.content ?? null,
          expectedRevision: commit.newRevision,
          sourceSha256: commit.previous?.sourceSha256,
          options: { env },
        });
        if (!revert.ok) {
          warnings.push(
            `Agent "${commit.agentId}" scratch changed before the migration rollback; leaving current scratch in place.`,
          );
        }
      }
      try {
        await claim.restore(undefined);
      } catch (error) {
        warnings.push(errorMessage(error));
      }
      continue;
    }
    try {
      // release() re-verifies and restores the claim itself when the bytes
      // changed, so no extra restore is needed on this failure path.
      await claim.release();
      changes.push(...groupChanges);
    } catch (error) {
      changes.push(...groupChanges);
      warnings.push(
        `${shortenHomePath(source.path)} was migrated but not removed: ${errorMessage(error)}. Rerun doctor to retry safely.`,
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
