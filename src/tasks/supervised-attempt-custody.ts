import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  AttemptPlanSchema,
  AttemptStorageLimitsSchema,
  AttemptScopeIdentitySchema,
  type SupervisedAttemptPlan,
  type SupervisedAttemptScopeIdentity,
} from "./supervised-attempt-custody.types.js";
import {
  assertSupervisedProcessScopeMember,
  inspectSupervisedProcessScope,
  isSealedSupervisedProcessScopeAbsent,
  isSupervisedProcessScopeClosed,
  readSupervisedProcessHostIdentity,
  supervisedProcessScopeName,
  validateSupervisedProcessResourceLimits,
  type SupervisedProcessResourceLimits,
} from "./supervised-process-resources.js";
import { readTask } from "./supervised-task.persistence.js";
import { assertSupervisedAttemptInTransaction } from "./supervised-task.store.js";
import type { SupervisedTask } from "./supervised-task.types.js";
import {
  readSupervisedWorkflow,
  writeSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";
import { readSupervisedWorkflowContractInTransaction } from "./supervised-workflow.store.js";
import { supervisedWorkspaceVersionPath } from "./supervised-workspace-path.js";
import { reserveSupervisedWorkspaceInTransaction } from "./supervised-workspace-retention.js";
import { readSupervisedWorkspaceHeadInTransaction } from "./supervised-workspace-versions.js";

const sql = (db: DatabaseSync) => getNodeSqliteKysely<DB>(db);
const TABLE = "task_flow_attempt_resources";

export function readAttemptResourceInTransaction(db: DatabaseSync, resourceId: string) {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    sql(db).selectFrom(TABLE).selectAll().where("resource_id", "=", resourceId),
  );
  if (!row) {
    throw new Error("Attempt resource reservation missing");
  }
  const plan = AttemptPlanSchema.parse(JSON.parse(row.plan_json));
  const identity =
    row.identity_json === null
      ? null
      : AttemptScopeIdentitySchema.parse(JSON.parse(row.identity_json));
  validateSupervisedProcessResourceLimits(plan.limits);
  if (
    row.resource_id !== plan.resourceId ||
    row.flow_id !== plan.flowId ||
    row.episode !== plan.episode ||
    row.attempt_id !== plan.attemptId ||
    row.scope_name !== supervisedProcessScopeName(plan.resourceId) ||
    (identity &&
      (identity.resourceId !== plan.resourceId ||
        identity.scopeName !== row.scope_name ||
        identity.hostId !== plan.hostId ||
        identity.bootId !== plan.bootId ||
        identity.limits.memoryBytes !== plan.limits.memoryBytes ||
        identity.limits.tasks !== plan.limits.tasks))
  ) {
    throw new Error("Attempt resource projection or immutable binding changed");
  }
  return { ...row, plan, identity };
}
export function getSupervisedAttemptResources(resourceId: string, options: Options = {}) {
  return readSupervisedWorkflow(
    (db) => (tableExists(db, TABLE) ? readAttemptResourceInTransaction(db, resourceId) : undefined),
    options,
  );
}

/** Advisory backpressure before consuming an attempt budget. Reservation's
 * transactional capacity check is still authoritative against racing workers. */
export function hasSupervisedAttemptResourceCapacity(
  flowId: string,
  options: Options = {},
): boolean {
  return (
    readSupervisedWorkflow((db) => {
      if (!tableExists(db, TABLE)) {
        return true;
      }
      const rows = executeSqliteQuerySync(
        db,
        sql(db).selectFrom(TABLE).select("flow_id").where("state", "!=", "closed").limit(8),
      ).rows;
      if (rows.length >= 8) {
        return false;
      }
      return !executeSqliteQueryTakeFirstSync(
        db,
        sql(db)
          .selectFrom(TABLE)
          .select("resource_id")
          .where("flow_id", "=", flowId)
          .where("state", "!=", "closed")
          .limit(1),
      );
    }, options) ?? true
  );
}

/** Return false only for recognized loss of authority. Corruption is not a
 * cleanup capability: all unexpected parse/store failures propagate. */
export function isAttemptResourceSourceCurrentInTransaction(
  db: DatabaseSync,
  plan: SupervisedAttemptPlan,
  now: number,
): boolean {
  const task = readTask(db, plan.flowId, plan.episode);
  if (
    !task ||
    task.attempt?.id !== plan.attemptId ||
    task.attempt.ownerId !== plan.attemptOwnerId ||
    task.attempt.startedAt !== plan.startedAt ||
    task.attempt.expiresAt !== plan.expiresAt
  ) {
    return false;
  }
  try {
    assertSupervisedAttemptInTransaction(db, task, now);
  } catch (error) {
    if (error instanceof Error && error.message === "Supervised attempt no longer owns execution") {
      return false;
    }
    throw error;
  }
  const contract = readSupervisedWorkflowContractInTransaction(db, plan.flowId, plan.episode);
  const draft = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_workspace_allocations")
      .selectAll()
      .where("allocation_id", "=", plan.allocationId),
  );
  if (
    !(
      (draft?.state === "reserved" ||
        (draft?.state === "released" &&
          executeSqliteQueryTakeFirstSync(
            db,
            sql(db)
              .selectFrom(TABLE)
              .select("resource_id")
              .where("resource_id", "=", plan.resourceId)
              .where("state", "=", "closed"),
          ))) &&
      draft.kind === "draft" &&
      draft.owner_kind === "attempt" &&
      draft.owner_id === plan.attemptId &&
      draft.flow_id === plan.flowId &&
      draft.episode === plan.episode &&
      draft.owner_pid === plan.launcher.pid &&
      draft.owner_start_time === plan.launcher.startTime
    )
  ) {
    return false;
  }
  if (!plan.workspace) {
    return !contract;
  }
  const head = readSupervisedWorkspaceHeadInTransaction(db, plan.flowId, plan.episode);
  if (
    contract?.hash !== plan.workspace.contractHash ||
    head?.version_id !== plan.workspace.sourceVersion ||
    head.source_hash !== plan.workspace.sourceHash
  ) {
    return false;
  }
  const source = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_workspace_allocations")
      .selectAll()
      .where("allocation_id", "=", plan.workspace.sourceVersion),
  );
  // Resume deliberately carries the previous episode's immutable version.
  return (
    source?.state === "retained" &&
    source.kind === "version" &&
    source.flow_id === plan.flowId &&
    source.episode <= plan.episode
  );
}

export function assertAttemptResourceCurrentInTransaction(
  db: DatabaseSync,
  resourceId: string,
  now: number,
) {
  const resource = readAttemptResourceInTransaction(db, resourceId);
  if (
    resource.state === "closed" ||
    resource.revoked_at_ms !== null ||
    !isAttemptResourceSourceCurrentInTransaction(db, resource.plan, now)
  ) {
    throw new Error("Attempt resource no longer owns execution");
  }
  return resource;
}
export function assertSupervisedAttemptResourcesCurrent(resourceId: string, options: Options = {}) {
  const resource = readSupervisedWorkflow(
    (db) => assertAttemptResourceCurrentInTransaction(db, resourceId, Date.now()),
    options,
  );
  if (!resource) {
    throw new Error("Attempt resource store unavailable");
  }
  return resource;
}

/** Runtime callbacks require the consumed payload gate, not just a live plan.
 * Check this OpenClaw file-tool-serving host, not just its model child. */
export function assertSupervisedAttemptPayloadCurrent(resourceId: string, options: Options = {}) {
  const resource = assertSupervisedAttemptResourcesCurrent(resourceId, options);
  if (resource.state !== "running" || !resource.identity) {
    throw new Error("Attempt payload gate is not active");
  }
  assertSupervisedProcessScopeMember(
    resource.identity,
    requireNodeWorkerProcessIdentity(process.pid),
  );
  return resource;
}

/** Fixed producer diagnostic, never model text. The exact in-scope payload
 * records it only after joining its runtime and tool adapters. */
export function recordSupervisedAttemptFormatFailure(
  resourceId: string,
  code: "invalid_json" | "invalid_shape" | "oversized",
  options: Options = {},
) {
  assertSupervisedAttemptPayloadCurrent(resourceId, options);
  writeSupervisedWorkflow((db) => {
    const resource = assertAttemptResourceCurrentInTransaction(db, resourceId, Date.now());
    if (resource.state !== "running") {
      throw new Error("Attempt payload no longer owns failure recording");
    }
    executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable(TABLE)
        .set({ failure_code: code })
        .where("resource_id", "=", resourceId)
        .where("failure_code", "is", null),
    );
  }, options);
}

function assertLocalLauncher(plan: SupervisedAttemptPlan) {
  const host = readSupervisedProcessHostIdentity();
  const processIdentity = requireNodeWorkerProcessIdentity(process.pid);
  if (
    host.hostId !== plan.hostId ||
    host.bootId !== plan.bootId ||
    processIdentity.pid !== plan.launcher.pid ||
    processIdentity.startTime !== plan.launcher.startTime
  ) {
    throw new Error("Attempt launch belongs to another exact host/process owner");
  }
}
function assertLocalCustodian(identity: SupervisedAttemptScopeIdentity) {
  const host = readSupervisedProcessHostIdentity();
  const processIdentity = requireNodeWorkerProcessIdentity(process.pid);
  if (
    host.hostId !== identity.hostId ||
    host.bootId !== identity.bootId ||
    processIdentity.pid !== identity.custodian.pid ||
    processIdentity.startTime !== identity.custodian.startTime
  ) {
    throw new Error("Attempt action belongs to another exact custodian");
  }
  assertSupervisedProcessScopeMember(identity, processIdentity);
}

/** Host-only API. Limits come from the accepted host policy, never model args.
 * No filesystem or subprocess work occurs in this transaction. Initial managed
 * source capture must have installed a retained head before reservation. */
export function reserveSupervisedAttemptResources(
  expected: SupervisedTask,
  limits: SupervisedProcessResourceLimits,
  options: Options = {},
  storage: SupervisedAttemptPlan["storage"] = {
    workingBytes: 128 * 1024 * 1024,
    workingInodes: 32768,
  },
): SupervisedAttemptPlan {
  validateSupervisedProcessResourceLimits(limits);
  const acceptedStorage = AttemptStorageLimitsSchema.parse(storage);
  const launcher = requireNodeWorkerProcessIdentity(process.pid);
  const host = readSupervisedProcessHostIdentity();
  return writeSupervisedWorkflow((db) => {
    const now = Date.now();
    const task = assertSupervisedAttemptInTransaction(db, expected, now);
    if (!task.attempt?.dispatched) {
      throw new Error("Attempt worker dispatch must be reserved first");
    }
    // Existing unique attempt rows are tombstones, including after closure.
    if (
      executeSqliteQueryTakeFirstSync(
        db,
        sql(db).selectFrom(TABLE).select("resource_id").where("attempt_id", "=", task.attempt.id),
      )
    ) {
      throw new Error("Attempt scope already reserved; reconcile without relaunch");
    }
    const held = executeSqliteQuerySync(
      db,
      sql(db).selectFrom(TABLE).select("flow_id").where("state", "!=", "closed").limit(8),
    ).rows;
    if (
      held.length >= 8 ||
      executeSqliteQueryTakeFirstSync(
        db,
        sql(db)
          .selectFrom(TABLE)
          .select("resource_id")
          .where("flow_id", "=", task.flowId)
          .where("state", "!=", "closed")
          .limit(1),
      )
    ) {
      throw new Error("Attempt physical scope capacity remains held");
    }
    const contract = readSupervisedWorkflowContractInTransaction(db, task.flowId, task.episode);
    let workspace: SupervisedAttemptPlan["workspace"] = null;
    if (contract) {
      const head = readSupervisedWorkspaceHeadInTransaction(db, task.flowId, task.episode);
      if (!head) {
        throw new Error("Attempt requires a retained accepted source before resource reservation");
      }
      workspace = {
        contractHash: contract.hash,
        sourceVersion: head.version_id,
        sourceHash: head.source_hash,
      };
    }
    const plan = AttemptPlanSchema.parse({
      resourceId: randomUUID(),
      allocationId: reserveSupervisedWorkspaceInTransaction(
        db,
        { kind: "attempt", task },
        "draft",
        now,
        true,
      ),
      storage: acceptedStorage,
      flowId: task.flowId,
      episode: task.episode,
      attemptId: task.attempt.id,
      attemptOwnerId: task.attempt.ownerId,
      startedAt: task.attempt.startedAt,
      expiresAt: task.attempt.expiresAt,
      launcher,
      ...host,
      limits: { ...limits },
      workspace,
    });
    if (!isAttemptResourceSourceCurrentInTransaction(db, plan, now)) {
      throw new Error("Attempt source changed during reservation");
    }
    executeSqliteQuerySync(
      db,
      sql(db)
        .insertInto(TABLE)
        .values({
          resource_id: plan.resourceId,
          flow_id: plan.flowId,
          episode: plan.episode,
          attempt_id: plan.attemptId,
          scope_name: supervisedProcessScopeName(plan.resourceId),
          state: "planned",
          plan_json: JSON.stringify(plan),
          identity_json: null,
          revoked_at_ms: null,
          launcher_joined_at_ms: null,
          cleanup_owner: null,
          cleanup_expires_at_ms: null,
          created_at_ms: now,
          updated_at_ms: now,
        }),
    );
    return plan;
  }, options);
}

/** Consume before OS spawn. A lost response is not a license to repeat spawn. */
export function beginSupervisedAttemptLaunch(resourceId: string, options: Options = {}) {
  return writeSupervisedWorkflow((db) => {
    const now = Date.now();
    const resource = assertAttemptResourceCurrentInTransaction(db, resourceId, now);
    assertLocalLauncher(resource.plan);
    const result = executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable(TABLE)
        .set({ state: "launching", updated_at_ms: now })
        .where("resource_id", "=", resourceId)
        .where("state", "=", "planned")
        .where("revoked_at_ms", "is", null),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error("Attempt launch gate already consumed");
    }
    return resource.plan;
  }, options);
}

/** Called inside the start-gated scope custodian. Observe the real kernel,
 * then reread source in the CAS transaction after all awaited inspection. */
export async function bindSupervisedAttemptResources(resourceId: string, options: Options = {}) {
  const assertCurrent = () => {
    assertSupervisedAttemptResourcesCurrent(resourceId, options);
  };
  const resource = assertSupervisedAttemptResourcesCurrent(resourceId, options);
  const identity = await inspectSupervisedProcessScope({
    resourceId,
    limits: resource.plan.limits,
    expectedProcess: requireNodeWorkerProcessIdentity(process.pid),
    assertCurrent,
  });
  return writeSupervisedWorkflow((db) => {
    const now = Date.now();
    const current = assertAttemptResourceCurrentInTransaction(db, resourceId, now);
    assertLocalCustodian(identity);
    if (current.plan.hostId !== identity.hostId || current.plan.bootId !== identity.bootId) {
      throw new Error("Attempt launch host changed");
    }
    const result = executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable(TABLE)
        .set({
          state: "bound",
          identity_json: JSON.stringify(AttemptScopeIdentitySchema.parse(identity)),
          updated_at_ms: now,
        })
        .where("resource_id", "=", resourceId)
        .where("state", "=", "launching")
        .where("revoked_at_ms", "is", null),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error("Attempt binding gate already consumed");
    }
    return identity;
  }, options);
}

/** Once only: namespace/private workspace setup must already be verified by
 * the trusted custodian. This reserves execution, not candidate acceptance. */
export function reserveSupervisedAttemptPayload(resourceId: string, options: Options = {}) {
  return writeSupervisedWorkflow((db) => {
    const now = Date.now();
    const resource = assertAttemptResourceCurrentInTransaction(db, resourceId, now);
    if (!resource.identity) {
      throw new Error("Attempt has no bound scope");
    }
    assertLocalCustodian(resource.identity);
    const result = executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable(TABLE)
        .set({ state: "running", updated_at_ms: now })
        .where("resource_id", "=", resourceId)
        .where("state", "=", "bound")
        .where("revoked_at_ms", "is", null),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error("Attempt payload dispatch already reserved");
    }
    return resource.plan;
  }, options);
}

/** Exact launch owner can revoke after source expiry. It cannot free capacity. */
export function revokeSupervisedAttemptResources(resourceId: string, options: Options = {}) {
  writeSupervisedWorkflow((db) => {
    const resource = readAttemptResourceInTransaction(db, resourceId);
    assertLocalLauncher(resource.plan);
    executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable(TABLE)
        .set({ revoked_at_ms: Date.now(), updated_at_ms: Date.now() })
        .where("resource_id", "=", resourceId)
        .where("revoked_at_ms", "is", null),
    );
  }, options);
}

/** Exact launcher calls only AFTER required-all transport extinction, including
 * the systemd helper. A launcher PID exit alone is not that observation. */
export function recordSupervisedAttemptLauncherJoined(resourceId: string, options: Options = {}) {
  writeSupervisedWorkflow((db) => {
    const resource = readAttemptResourceInTransaction(db, resourceId);
    assertLocalLauncher(resource.plan);
    if (resource.revoked_at_ms === null) {
      throw new Error("Seal attempt gates before recording launcher join");
    }
    executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable(TABLE)
        .set({ launcher_joined_at_ms: Date.now(), updated_at_ms: Date.now() })
        .where("resource_id", "=", resourceId)
        .where("launcher_joined_at_ms", "is", null),
    );
  }, options);
}

/** Physical observation only. Never settles a decision or grants new source
 * authority. Unknown unbound launches retain their tombstone/physical slot. */
export async function closeSupervisedAttemptResources(
  resourceId: string,
  options: Options = {},
): Promise<boolean> {
  const resource = getSupervisedAttemptResources(resourceId, options);
  if (!resource) {
    throw new Error("Attempt resource store unavailable");
  }
  if (resource.state === "closed") {
    return true;
  }
  if (resource.revoked_at_ms === null) {
    throw new Error("Attempt gates must be revoked before closure");
  }
  if (resource.identity) {
    if (!(await isSupervisedProcessScopeClosed(resource.identity))) {
      return false;
    }
  } else {
    const host = readSupervisedProcessHostIdentity();
    if (host.hostId !== resource.plan.hostId) {
      throw new Error("Unbound attempt belongs to another host");
    }
    if (host.bootId === resource.plan.bootId) {
      // planned means beginLaunch never consumed; its closed gate forbids spawn.
      if (resource.state !== "planned" && resource.launcher_joined_at_ms === null) {
        return false;
      }
      if (!(await isSealedSupervisedProcessScopeAbsent(resourceId))) {
        return false;
      }
    }
  }
  return writeSupervisedWorkflow((db) => {
    const current = readAttemptResourceInTransaction(db, resourceId);
    if (
      current.plan_json !== resource.plan_json ||
      current.identity_json !== resource.identity_json ||
      current.revoked_at_ms === null
    ) {
      throw new Error("Attempt closure no longer matches sealed resource");
    }
    if (current.state === "closed") {
      return true;
    }
    const result = executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable(TABLE)
        .set({
          state: "closed",
          cleanup_owner: null,
          cleanup_expires_at_ms: null,
          updated_at_ms: Date.now(),
        })
        .where("resource_id", "=", resourceId)
        .where("state", "=", current.state)
        .where("revoked_at_ms", "is not", null),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error("Attempt closure conflict");
    }
    // Physical extinction ends writer custody even when parsing, preparation,
    // or candidate acceptance failed. It does not authorize deleting evidence.
    const released = executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable("task_flow_workspace_allocations")
        .set({ state: "released", updated_at_ms: Date.now() })
        .where("allocation_id", "=", current.plan.allocationId)
        .where("flow_id", "=", current.plan.flowId)
        .where("episode", "=", current.plan.episode)
        .where("owner_kind", "=", "attempt")
        .where("owner_id", "=", current.plan.attemptId)
        .where("owner_pid", "=", current.plan.launcher.pid)
        .where("owner_start_time", "=", current.plan.launcher.startTime)
        .where("kind", "=", "draft")
        .where("state", "in", ["reserved", "released"]),
    );
    if (released.numAffectedRows !== 1n) {
      throw new Error("Attempt closure lost its exact draft");
    }
    return true;
  }, options);
}

/** SQL-selected context; a child argument chooses only the reserved resource.
 * Parent must not expose this DB path or API as a model-owned capability. */
export function readSupervisedAttemptContext(resourceId: string, options: Options = {}) {
  return readSupervisedWorkflow((db) => {
    const resource = assertAttemptResourceCurrentInTransaction(db, resourceId, Date.now());
    const task = readTask(db, resource.plan.flowId, resource.plan.episode);
    if (!task) {
      throw new Error("Attempt source task disappeared");
    }
    return {
      task,
      plan: resource.plan,
      identity: resource.identity,
      sourceWorkspace: resource.plan.workspace
        ? supervisedWorkspaceVersionPath(resource.plan.workspace.sourceVersion, options)
        : null,
      allocationRoot: supervisedWorkspaceVersionPath(resource.plan.allocationId, options),
    };
  }, options);
}
