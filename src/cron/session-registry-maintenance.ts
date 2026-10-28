import { formatCliCommand } from "../cli/command-format.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  resolveConfiguredAgentDatabaseTargets,
  runSessionRegistryMaintenanceForStore,
} from "../config/sessions.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveAllAgentSessionStoreTargetsAsync } from "../config/sessions/targets-runtime.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isGatewayRestartDrainError } from "../process/gateway-work-admission.js";
import {
  AgentDatabaseAdmissionError,
  isTransientAgentDatabaseContention,
  listAgentDatabaseAdmissionRefusals,
  readAgentDatabaseAdmissionRefusal,
  type AgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";
import { createRetainedAgentDatabaseMatcherFromSnapshot } from "../state/agent-deletion-discovery.js";
import {
  isAgentDatabaseDeletionSnapshotChangedError,
  prepareAgentDatabaseDeletionSnapshotRead,
} from "../state/agent-deletion-journal.read.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { loadCronJobsStoreWithConfigJobsReadOnly } from "./store/read-only.js";

const log = createSubsystemLogger("cron/maintenance");

const SESSION_REGISTRY_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * Only a refusal or transient contention may be skipped for one store.
 *
 * An admission refusal means this agent's database is unavailable right now; a
 * lock means another writer held it for a moment. Both are recoverable for the
 * other stores, which must keep their own session retention. A damaged database
 * or a schema mismatch is terminal and stays terminal.
 */
function isIsolatableAgentStoreFailure(error: unknown): boolean {
  return error instanceof AgentDatabaseAdmissionError || isTransientAgentDatabaseContention(error);
}

type SessionRegistryMaintenanceStoreIdentity = {
  agentId: string;
  storePath: string;
};

type SessionRegistryMaintenanceStoreSummary =
  | (SessionRegistryMaintenanceStoreIdentity & {
      pruned: number;
      preservedRunning: number;
      nextSweepAtMs: number | null;
    })
  | (SessionRegistryMaintenanceStoreIdentity & {
      skippedReason:
        | "agent-deletion-pending"
        | "agent-deletion-complete"
        | AgentDatabaseAdmissionRefusal["code"];
    })
  | (SessionRegistryMaintenanceStoreIdentity & {
      skippedReason: "agent-store-held";
      warning: string;
    })
  | (SessionRegistryMaintenanceStoreIdentity & {
      skippedReason: "agent-store-failed";
      warning: string;
    });

type SessionRegistryMaintenanceSummary = {
  retentionMs: number;
  runningCronJobs: number;
  pruned: number;
  skippedStores: number;
  /** Stores whose own maintenance failed; the remaining stores were still maintained. */
  failedStores: number;
  stores: SessionRegistryMaintenanceStoreSummary[];
  nextSweepAtMs: number | null;
  /** Set when missing cron or child inventory facts prevent safe pruning. */
  skippedReason?: string;
};

function resolveExplicitCronSessionSegment(sessionKey: string | undefined): string | undefined {
  const match = /^(?:agent:[^:]+:)?cron:([^:]+)$/u.exec(sessionKey?.trim() ?? "");
  return match?.[1]?.toLowerCase();
}

type RunningCronJobIds =
  | { ok: true; ids: Set<string>; count: number }
  | { ok: false; reason: string };

async function readRunningCronJobIds(cronStorePath: string): Promise<RunningCronJobIds> {
  try {
    const runningJobs = (
      await loadCronJobsStoreWithConfigJobsReadOnly(cronStorePath)
    ).store.jobs.filter((job) => typeof job.state?.runningAtMs === "number");
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
  cronStorePath: string;
  assertCurrent?: () => void;
}): Promise<SessionRegistryMaintenanceSummary> {
  params.assertCurrent?.();
  const cfg = getRuntimeConfig();
  const runningCronJobs = await readRunningCronJobIds(params.cronStorePath);
  params.assertCurrent?.();
  if (!runningCronJobs.ok) {
    return {
      retentionMs: SESSION_REGISTRY_RETENTION_MS,
      runningCronJobs: 0,
      pruned: 0,
      skippedStores: 0,
      failedStores: 0,
      stores: [],
      nextSweepAtMs: Date.now() + 60_000,
      skippedReason: `cron store unreadable: ${runningCronJobs.reason}`,
    };
  }
  const env = process.env;
  return await prepareAgentDatabaseDeletionSnapshotRead({ env }).withCurrentSnapshot(
    async (snapshot, assertSnapshotCurrent) => {
      const stores: SessionRegistryMaintenanceStoreSummary[] = listAgentDatabaseAdmissionRefusals({
        env,
      })
        .filter((refusal) => readAgentDatabaseAdmissionRefusal(refusal.agentId, { env }))
        .flatMap((refusal) =>
          refusal.paths.map((storePath) => ({
            agentId: refusal.agentId,
            storePath,
            skippedReason: refusal.code,
          })),
        );
      const assertCurrent = () => {
        params.assertCurrent?.();
        assertSnapshotCurrent();
      };
      assertCurrent();
      const registeredDatabases = (snapshot?.registeredAgentDatabases ?? []).filter(
        (entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION,
      );
      const isRetained = createRetainedAgentDatabaseMatcherFromSnapshot(
        env,
        () => resolveConfiguredAgentDatabaseTargets(cfg, { env, registeredDatabases }),
        snapshot,
      );
      const deletedAgents = new Map(
        snapshot?.deletedAgents.map(({ agentId, status }) => [agentId, status]),
      );
      const targets = await resolveAllAgentSessionStoreTargetsAsync(cfg, {
        env,
        registeredDatabases,
      });
      const eligibleTargets: typeof targets = [];
      for (const target of targets) {
        assertCurrent();
        const deletion = deletedAgents.get(target.agentId) ?? "absent";
        const databasePath =
          deletion !== "absent"
            ? target.storePath
            : resolveSqliteTargetFromSessionStorePath(target.storePath, {
                agentId: target.agentId,
                env,
                registeredDatabases,
              }).path;
        const retained =
          deletion === "absent" ? isRetained(databasePath, target.agentId) : undefined;
        if (deletion !== "absent" || typeof retained === "object") {
          // Deletion owns these stores until cleanup settles and retains its tombstone afterward.
          stores.push({
            ...target,
            skippedReason:
              deletion === "pending" ? "agent-deletion-pending" : "agent-deletion-complete",
          });
          continue;
        }
        if (retained) {
          const reason =
            retained === "held"
              ? "deletion journal reconstruction"
              : "deletion journal unavailable";
          const warning = `Held agent ${target.agentId} database ${databasePath} (${reason}); skipped session retention. Run "${formatCliCommand("openclaw doctor --fix", env)}" for explicit restoration guidance.`;
          log.warn(warning);
          stores.push({ ...target, skippedReason: "agent-store-held", warning });
          continue;
        }
        eligibleTargets.push(target);
      }
      // Unavailable stores can still own live children of otherwise eligible parents.
      const incompleteInventory = stores.some(
        (store) =>
          "skippedReason" in store &&
          store.skippedReason !== "agent-deletion-pending" &&
          store.skippedReason !== "agent-deletion-complete" &&
          !deletedAgents.has(store.agentId),
      );
      for (const target of incompleteInventory ? [] : eligibleTargets) {
        assertCurrent();
        let result: Awaited<ReturnType<typeof runSessionRegistryMaintenanceForStore>>;
        try {
          result = await runSessionRegistryMaintenanceForStore({
            ...target,
            apply: params.apply,
            retentionMs: SESSION_REGISTRY_RETENTION_MS,
            runningCronJobIds: runningCronJobs.ids,
            childStores: eligibleTargets,
            assertCurrent,
          });
        } catch (error) {
          // Restart drain and snapshot changes are sweep-level conditions, not store failures.
          if (
            isGatewayRestartDrainError(error) ||
            isAgentDatabaseDeletionSnapshotChangedError(error)
          ) {
            throw error;
          }
          // A refused or contended store must not abort the sweep for every other
          // store. Anything else (a damaged database, a schema mismatch) stays
          // terminal: the sweep keeps failing loudly instead of skipping silently.
          if (!isIsolatableAgentStoreFailure(error)) {
            throw error;
          }
          const reason = formatErrorMessage(error);
          log.warn("Session registry maintenance skipped for one agent store", {
            agentId: target.agentId,
            storePath: target.storePath,
            reason,
          });
          stores.push({
            agentId: target.agentId,
            storePath: target.storePath,
            skippedReason: "agent-store-failed",
            warning: reason,
          });
          continue;
        }
        assertCurrent();
        stores.push({
          agentId: target.agentId,
          storePath: target.storePath,
          pruned: result.pruned,
          preservedRunning: result.preservedRunning,
          nextSweepAtMs: result.nextSweepAtMs,
        });
      }
      const deadlines = stores.flatMap((store) =>
        "nextSweepAtMs" in store
          ? store.nextSweepAtMs === null
            ? []
            : [store.nextSweepAtMs]
          : store.skippedReason === "agent-deletion-pending"
            ? [Date.now() + 60_000]
            : [],
      );
      if (incompleteInventory) {
        deadlines.push(Date.now() + 60_000);
      }
      return {
        nextSweepAtMs: deadlines.length > 0 ? Math.min(...deadlines) : null,
        ...(incompleteInventory ? { skippedReason: "session child inventory incomplete" } : {}),
        retentionMs: SESSION_REGISTRY_RETENTION_MS,
        runningCronJobs: runningCronJobs.count,
        pruned: stores.reduce((total, store) => total + ("pruned" in store ? store.pruned : 0), 0),
        skippedStores: stores.filter((store) => "skippedReason" in store).length,
        failedStores: stores.filter(
          (store) => "skippedReason" in store && store.skippedReason === "agent-store-failed",
        ).length,
        stores,
      };
    },
  );
}
