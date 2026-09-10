import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeSupervisedAttemptResources,
  isAttemptResourceSourceCurrentInTransaction,
  readAttemptResourceInTransaction,
} from "./supervised-attempt-custody.js";
import {
  AttemptCleanupSchema,
  type SupervisedAttemptCleanup,
} from "./supervised-attempt-custody.types.js";
import {
  readSupervisedProcessHostIdentity,
  terminateSupervisedProcessScope,
} from "./supervised-process-resources.js";
import { supervisorCurrent } from "./supervised-task.persistence.js";
import {
  readSupervisedWorkflow,
  writeSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";

const sql = (db: DatabaseSync) => getNodeSqliteKysely<DB>(db);
const TABLE = "task_flow_attempt_resources";
const PAGE_SIZE = 8;
const LEASE_MS = 30_000;
type CleanupClaim = { resourceId: string; owner: SupervisedAttemptCleanup; encoded: string };

function assertCleanupSupervisor(
  db: DatabaseSync,
  owner: SupervisedAttemptCleanup,
  flowId: string,
  now: number,
) {
  const processIdentity = requireNodeWorkerProcessIdentity(process.pid);
  const host = readSupervisedProcessHostIdentity();
  if (
    host.hostId !== owner.hostId ||
    host.bootId !== owner.bootId ||
    processIdentity.pid !== owner.process.pid ||
    processIdentity.startTime !== owner.process.startTime ||
    !supervisorCurrent(db, owner.supervisorId, now, flowId)
  ) {
    throw new Error("Attempt cleanup supervisor/process no longer current");
  }
}

/** Separate, nonrenewing cleanup custody. Claims are terminal-inclusive and
 * never authorize payload or candidate publication. A new nonce fences ABA. */
export function claimSupervisedAttemptCleanup(
  resourceId: string,
  supervisorId: string,
  options: Options = {},
): CleanupClaim | null {
  const owner = AttemptCleanupSchema.parse({
    nonce: randomUUID(),
    supervisorId,
    process: requireNodeWorkerProcessIdentity(process.pid),
    ...readSupervisedProcessHostIdentity(),
  });
  const encoded = JSON.stringify(owner);
  return writeSupervisedWorkflow((db) => {
    const now = Date.now();
    const resource = readAttemptResourceInTransaction(db, resourceId);
    assertCleanupSupervisor(db, owner, resource.plan.flowId, now);
    if (owner.hostId !== resource.plan.hostId) {
      throw new Error("Attempt cleanup belongs to another host");
    }
    if (
      resource.state === "closed" ||
      (resource.revoked_at_ms === null &&
        isAttemptResourceSourceCurrentInTransaction(db, resource.plan, now))
    ) {
      return null;
    }
    const result = executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable(TABLE)
        .set({
          cleanup_owner: encoded,
          cleanup_expires_at_ms: now + LEASE_MS,
          revoked_at_ms: resource.revoked_at_ms ?? now,
          updated_at_ms: now,
        })
        .where("resource_id", "=", resourceId)
        .where("state", "!=", "closed")
        .where((eb) =>
          eb.or([eb("cleanup_owner", "is", null), eb("cleanup_expires_at_ms", "<=", now)]),
        ),
    );
    return result.numAffectedRows === 1n ? { resourceId, owner, encoded } : null;
  }, options);
}

export function assertSupervisedAttemptCleanupCurrent(claim: CleanupClaim, options: Options = {}) {
  const current = readSupervisedWorkflow((db) => {
    const resource = readAttemptResourceInTransaction(db, claim.resourceId);
    const now = Date.now();
    assertCleanupSupervisor(db, claim.owner, resource.plan.flowId, now);
    if (
      resource.state === "closed" ||
      resource.revoked_at_ms === null ||
      resource.cleanup_owner !== claim.encoded ||
      resource.cleanup_expires_at_ms === null ||
      resource.cleanup_expires_at_ms <= now
    ) {
      throw new Error("Attempt cleanup lease no longer current");
    }
    return resource;
  }, options);
  if (!current) {
    throw new Error("Attempt cleanup store unavailable");
  }
  return current;
}

function releaseCleanup(claim: CleanupClaim, options: Options) {
  writeSupervisedWorkflow(
    (db) =>
      executeSqliteQuerySync(
        db,
        sql(db)
          .updateTable(TABLE)
          .set({ cleanup_owner: null, cleanup_expires_at_ms: null })
          .where("resource_id", "=", claim.resourceId)
          .where("cleanup_owner", "=", claim.encoded),
      ),
    options,
  );
}

/** Caller owns the cursor and a live supervisor registration. Eight rows per
 * pass, including cancelled/old attempts. Unknown launch windows stay held;
 * no kill by guessed unit name and no launch replay. */
export async function sweepSupervisedAttemptResources(params: {
  supervisorId: string;
  options?: Options;
  assertCleanupCurrent: () => void;
  onError: (error: unknown) => void;
  onlyFlowId?: string;
  afterResourceId?: string;
}): Promise<{ inspected: number; nextResourceId?: string }> {
  const options = params.options ?? {};
  params.assertCleanupCurrent();
  const rows =
    readSupervisedWorkflow((db) => {
      if (!tableExists(db, TABLE)) {
        return [];
      }
      let query = sql(db)
        .selectFrom(TABLE)
        .select("resource_id")
        .where("state", "!=", "closed")
        .orderBy("resource_id", "asc")
        .limit(PAGE_SIZE);
      if (params.onlyFlowId !== undefined) {
        query = query.where("flow_id", "=", params.onlyFlowId);
      }
      if (params.afterResourceId !== undefined) {
        query = query.where("resource_id", ">", params.afterResourceId);
      }
      return executeSqliteQuerySync(db, query).rows;
    }, options) ?? [];
  const report = (error: unknown) => {
    try {
      params.onError(error);
    } catch {
      /* Observer cannot strand custody. */
    }
  };
  for (const row of rows) {
    let claim: CleanupClaim | null = null;
    try {
      params.assertCleanupCurrent();
      claim = claimSupervisedAttemptCleanup(row.resource_id, params.supervisorId, options);
      if (!claim) {
        continue;
      }
      const capturedClaim = claim;
      const assertOwned = () => {
        params.assertCleanupCurrent();
        assertSupervisedAttemptCleanupCurrent(capturedClaim, options);
      };
      assertOwned();
      if (await closeSupervisedAttemptResources(row.resource_id, options)) {
        continue;
      }
      const resource = assertSupervisedAttemptCleanupCurrent(claim, options);
      // Without a bound InvocationID+cgroup+inode, signaling is prohibited.
      // A crash between beginLaunch and bind stays held until exact launcher
      // join is available, or changed-boot proof establishes extinction.
      if (!resource.identity) {
        continue;
      }
      await terminateSupervisedProcessScope(resource.identity, assertOwned);
      // Closure observation may outlive source/cleanup leases; signaling may not.
      await closeSupervisedAttemptResources(row.resource_id, options);
    } catch (error) {
      report(error);
    } finally {
      if (claim) {
        try {
          releaseCleanup(claim, options);
        } catch (error) {
          report(error);
        }
      }
    }
  }
  return {
    inspected: rows.length,
    nextResourceId: rows.length === PAGE_SIZE ? rows.at(-1)?.resource_id : undefined,
  };
}
