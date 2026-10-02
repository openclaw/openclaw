// Cron-owned session retention preserves transcripts owned by running jobs.
import { formatCliCommand } from "../cli/command-format.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  resolveAllAgentSessionStoreTargetsSync,
  resolveConfiguredAgentDatabaseTargets,
  runSessionRegistryMaintenanceForStore,
} from "../config/sessions.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createRetainedAgentDatabaseMatcher } from "../state/agent-deletion-discovery.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { loadCronJobsStore, resolveCronJobsStorePath } from "./store.js";

const log = createSubsystemLogger("cron/maintenance");

const SESSION_REGISTRY_RETENTION_MS = 7 * 24 * 60 * 60_000;

type SessionRegistryMaintenanceStoreIdentity = {
  agentId: string;
  storePath: string;
};

type SessionRegistryMaintenanceStoreSummary =
  | (SessionRegistryMaintenanceStoreIdentity & {
      beforeCount: number;
      afterCount: number;
      pruned: number;
      preservedRunning: number;
    })
  | (SessionRegistryMaintenanceStoreIdentity & {
      skippedReason: "agent-deletion-complete";
    })
  | (SessionRegistryMaintenanceStoreIdentity & {
      skippedReason: "agent-store-held";
      warning: string;
    });

type SessionRegistryMaintenanceSummary = {
  retentionMs: number;
  runningCronJobs: number;
  pruned: number;
  skippedStores: number;
  stores: SessionRegistryMaintenanceStoreSummary[];
  /** Set when the sweep did not run; pruning without cron facts would archive live transcripts. */
  skippedReason?: string;
};

function resolveExplicitCronSessionSegment(sessionKey: string | undefined): string | undefined {
  const match = /^(?:agent:[^:]+:)?cron:([^:]+)$/u.exec(sessionKey?.trim() ?? "");
  return match?.[1]?.toLowerCase();
}

type RunningCronJobIds =
  | { ok: true; ids: Set<string>; count: number }
  | { ok: false; reason: string };

async function readRunningCronJobIds(): Promise<RunningCronJobIds> {
  try {
    const cronStorePath = resolveCronJobsStorePath();
    const runningJobs = (await loadCronJobsStore(cronStorePath)).jobs.filter(
      (job) => typeof job.state?.runningAtMs === "number",
    );
    // A running detached job may have been retargeted after its session was created. Keep its
    // explicit session segment because the registry has no producer metadata for the transcript.
    const ids = new Set<string>();
    for (const job of runningJobs) {
      ids.add(job.id.toLowerCase());
      if (job.sessionTarget === "main") {
        continue;
      }
      const explicitSessionSegment = resolveExplicitCronSessionSegment(job.sessionKey);
      if (explicitSessionSegment) {
        ids.add(explicitSessionSegment);
      }
    }
    return {
      ok: true,
      ids,
      count: runningJobs.length,
    };
  } catch (err) {
    // An unreadable cron store must not look like "no running jobs": the
    // session sweep would then archive transcripts of jobs that are running.
    return { ok: false, reason: formatErrorMessage(err) };
  }
}

export async function runSessionRegistryMaintenance(params: {
  apply: boolean;
  assertCurrent?: () => void;
}): Promise<SessionRegistryMaintenanceSummary> {
  params.assertCurrent?.();
  const cfg = getRuntimeConfig();
  const runningCronJobs = await readRunningCronJobIds();
  params.assertCurrent?.();
  if (!runningCronJobs.ok) {
    return {
      retentionMs: SESSION_REGISTRY_RETENTION_MS,
      runningCronJobs: 0,
      pruned: 0,
      skippedStores: 0,
      stores: [],
      skippedReason: `cron store unreadable: ${runningCronJobs.reason}`,
    };
  }
  const stores: SessionRegistryMaintenanceStoreSummary[] = [];
  const env = process.env;
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    params.assertCurrent?.();
    const deletion = readAgentDeletionJournal(target.agentId, { env }, "runtime");
    const databasePath = deletion
      ? target.storePath
      : resolveSqliteTargetFromSessionStorePath(target.storePath, {
          agentId: target.agentId,
          env,
        }).path;
    const retained = deletion
      ? undefined
      : createRetainedAgentDatabaseMatcher(env, () =>
          resolveConfiguredAgentDatabaseTargets(cfg, { env }),
        )(databasePath, target.agentId);
    if (deletion?.cleanupCompleted || typeof retained === "object") {
      // Completed tombstones intentionally keep retired stores unavailable.
      // Record that lifecycle outcome instead of reopening the fenced database.
      stores.push({ ...target, skippedReason: "agent-deletion-complete" });
      continue;
    }
    if (deletion) {
      // The former writable listing refused incomplete deletion; read-only workers must too.
      throw new Error(
        `OpenClaw agent database is unavailable while agent ${target.agentId} is deleted.`,
      );
    }
    if (retained) {
      const reason =
        retained === "held" ? "deletion journal reconstruction" : "deletion journal unavailable";
      const warning = `Held agent ${target.agentId} database ${databasePath} (${reason}); skipped session retention. Run "${formatCliCommand("openclaw doctor --fix", env)}" for explicit restoration guidance.`;
      log.warn(warning);
      stores.push({ ...target, skippedReason: "agent-store-held", warning });
      continue;
    }
    const result = await runSessionRegistryMaintenanceForStore({
      ...target,
      apply: params.apply,
      retentionMs: SESSION_REGISTRY_RETENTION_MS,
      runningCronJobIds: runningCronJobs.ids,
      assertCurrent: params.assertCurrent,
    });
    params.assertCurrent?.();
    stores.push({
      agentId: target.agentId,
      storePath: target.storePath,
      beforeCount: result.beforeCount,
      afterCount: result.afterCount,
      pruned: result.pruned,
      preservedRunning: result.preservedRunning,
    });
  }
  return {
    retentionMs: SESSION_REGISTRY_RETENTION_MS,
    runningCronJobs: runningCronJobs.count,
    pruned: stores.reduce((total, store) => total + ("pruned" in store ? store.pruned : 0), 0),
    skippedStores: stores.filter((store) => "skippedReason" in store).length,
    stores,
  };
}
