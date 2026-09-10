import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  assertAttemptResourceCurrentInTransaction,
  isAttemptResourceSourceCurrentInTransaction,
  readAttemptResourceInTransaction,
} from "./supervised-attempt-custody.js";
import { enqueueSupervisedOperationInTransaction } from "./supervised-operation.store.js";
import {
  assertSupervisedProcessScopeMember,
  readSupervisedProcessHostIdentity,
} from "./supervised-process-resources.js";
import { readTask } from "./supervised-task.persistence.js";
import {
  assertSupervisedAttemptInTransaction,
  settleSupervisedDecisionInTransaction,
} from "./supervised-task.store.js";
import {
  SupervisedDecisionSchema,
  validateSupervisedTask,
  type SupervisedDecision,
  type SupervisedTask,
} from "./supervised-task.types.js";
import {
  verifySupervisedWorkflowAcceptance,
  type SupervisedAcceptanceProof,
} from "./supervised-workflow.acceptance.js";
import {
  readSupervisedWorkflow,
  writeSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";
import { readSupervisedWorkflowContractInTransaction } from "./supervised-workflow.store.js";
import { supervisedWorkspaceVersionPath } from "./supervised-workspace-path.js";
import { reserveSupervisedWorkspaceInTransaction } from "./supervised-workspace-retention.js";
import {
  cloneSupervisedWorkspaceSnapshot,
  commitSupervisedWorkspaceVersionInTransaction,
} from "./supervised-workspace-versions.js";
import { captureSupervisedWorkspace } from "./supervised-workspace.js";

const sql = (db: DatabaseSync) => getNodeSqliteKysely<DB>(db);
const TABLE = "task_flow_attempt_candidates";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const SnapshotSchema = z.strictObject({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(4096),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z
          .number()
          .int()
          .min(0)
          .max(8 * 1024 * 1024),
        executable: z.boolean(),
      }),
    )
    .max(20_000),
});

function decodeSnapshot(json: string) {
  if (Buffer.byteLength(json) > 8 * 1024 * 1024) {
    throw new Error("Candidate manifest exceeds 8 MiB");
  }
  const snapshot = SnapshotSchema.parse(JSON.parse(json));
  let previous: string | undefined;
  let bytes = 0;
  for (const file of snapshot.files) {
    const segments = file.path.split("/");
    if (
      file.path.includes("\\") ||
      segments.some(
        (part) =>
          !part || part === "." || part === ".." || part === ".git" || part === "node_modules",
      ) ||
      (previous !== undefined && previous >= file.path)
    ) {
      throw new Error("Candidate manifest paths are not canonical and uniquely ordered");
    }
    previous = file.path;
    bytes += file.bytes;
  }
  if (bytes > 64 * 1024 * 1024 || digest(JSON.stringify(snapshot.files)) !== snapshot.hash) {
    throw new Error("Candidate manifest content or total byte count is invalid");
  }
  return snapshot;
}

function readCandidate(db: DatabaseSync, resourceId: string) {
  const resource = readAttemptResourceInTransaction(db, resourceId);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    sql(db).selectFrom(TABLE).selectAll().where("resource_id", "=", resourceId),
  );
  if (!row) {
    throw new Error("Attempt decision has not been staged");
  }
  if (
    row.plan_hash !== digest(resource.plan_json) ||
    row.identity_hash !== digest(resource.identity_json ?? "") ||
    row.decision_hash !== digest(row.decision_json) ||
    row.attempt_id !== resource.plan.attemptId
  ) {
    throw new Error("Attempt candidate no longer matches its immutable source and custody");
  }
  const task = validateSupervisedTask(JSON.parse(row.task_json));
  if (
    task.flowId !== resource.plan.flowId ||
    task.episode !== resource.plan.episode ||
    task.attempt?.id !== resource.plan.attemptId ||
    task.attempt.ownerId !== resource.plan.attemptOwnerId ||
    task.attempt.startedAt !== resource.plan.startedAt ||
    task.attempt.expiresAt !== resource.plan.expiresAt
  ) {
    throw new Error("Staged task is not the attempt resource source");
  }
  const decision = SupervisedDecisionSchema.parse(JSON.parse(row.decision_json));
  const snapshot = row.manifest_json === null ? null : decodeSnapshot(row.manifest_json);
  if (
    (row.version_id === null) !== (snapshot === null) ||
    (row.state !== "decision" && Boolean(resource.plan.workspace) !== Boolean(snapshot))
  ) {
    throw new Error("Candidate workspace projection is invalid");
  }
  if (row.version_id && row.state !== "consumed") {
    const allocation = executeSqliteQueryTakeFirstSync(
      db,
      sql(db)
        .selectFrom("task_flow_workspace_allocations")
        .selectAll()
        .where("allocation_id", "=", row.version_id),
    );
    if (
      !resource.identity ||
      !allocation ||
      allocation.flow_id !== task.flowId ||
      allocation.episode !== task.episode ||
      allocation.owner_kind !== "attempt" ||
      allocation.owner_id !== resource.plan.attemptId ||
      allocation.owner_pid !== resource.identity.custodian.pid ||
      allocation.owner_start_time !== resource.identity.custodian.startTime ||
      allocation.kind !== "version" ||
      allocation.state !== "reserved"
    ) {
      throw new Error("Candidate version has no exact custodian-owned reservation");
    }
  }
  return { row, resource, task, decision, snapshot };
}

function assertSource(db: DatabaseSync, staged: ReturnType<typeof readCandidate>, now: number) {
  const task = assertSupervisedAttemptInTransaction(db, staged.task, now);
  if (
    task.revision !== staged.task.revision ||
    !isAttemptResourceSourceCurrentInTransaction(db, staged.resource.plan, now)
  ) {
    throw new Error("Attempt candidate source was superseded");
  }
  return task;
}

function assertCustodian(db: DatabaseSync, staged: ReturnType<typeof readCandidate>, now: number) {
  const resource = assertAttemptResourceCurrentInTransaction(db, staged.resource.resource_id, now);
  const identity = requireNodeWorkerProcessIdentity(process.pid);
  const host = readSupervisedProcessHostIdentity();
  if (
    resource.state !== "running" ||
    !resource.identity ||
    resource.identity.custodian.pid !== identity.pid ||
    resource.identity.custodian.startTime !== identity.startTime ||
    resource.identity.hostId !== host.hostId ||
    resource.identity.bootId !== host.bootId
  ) {
    throw new Error("Candidate preparation belongs to the exact bound custodian");
  }
  assertSupervisedProcessScopeMember(resource.identity, identity);
  return assertSource(db, staged, now);
}

/** Trusted payload entrypoint only; never registered as a model tool or RPC.
 * All actual runtime attribution/terminal-result checks precede this call.
 * SQL does not treat stdout, a model claim or a source UUID as custody. */
export function stageSupervisedAttemptDecision(
  resourceId: string,
  decisionJson: string,
  options: Options = {},
) {
  if (Buffer.byteLength(decisionJson) > 64 * 1024) {
    throw new Error("Attempt decision exceeds 64 KiB");
  }
  const canonical = JSON.stringify(SupervisedDecisionSchema.parse(JSON.parse(decisionJson)));
  writeSupervisedWorkflow((db) => {
    const resource = assertAttemptResourceCurrentInTransaction(db, resourceId, Date.now());
    if (resource.state !== "running" || !resource.identity) {
      throw new Error("Payload gate is not active");
    }
    assertSupervisedProcessScopeMember(
      resource.identity,
      requireNodeWorkerProcessIdentity(process.pid),
    );
    const task = readTask(db, resource.plan.flowId, resource.plan.episode);
    if (!task) {
      throw new Error("Attempt source task disappeared");
    }
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      sql(db).selectFrom(TABLE).selectAll().where("resource_id", "=", resourceId),
    );
    if (existing) {
      if (
        existing.decision_json !== canonical ||
        existing.plan_hash !== digest(resource.plan_json) ||
        existing.identity_hash !== digest(resource.identity_json ?? "")
      ) {
        throw new Error("Attempt decision is immutable");
      }
      return;
    }
    executeSqliteQuerySync(
      db,
      sql(db)
        .insertInto(TABLE)
        .values({
          resource_id: resourceId,
          attempt_id: resource.plan.attemptId,
          plan_hash: digest(resource.plan_json),
          identity_hash: digest(resource.identity_json ?? ""),
          task_json: JSON.stringify(task),
          decision_json: canonical,
          decision_hash: digest(canonical),
          state: "decision",
          version_id: null,
          manifest_json: null,
          settled_task_json: null,
          staged_at_ms: Date.now(),
          sealed_at_ms: null,
          consumed_at_ms: null,
        }),
    );
  }, options);
}

/** Exact trusted custodian calls AFTER required-all payload join, read-only
 * remount and manifest-only export. This method creates no runtime and grants
 * no model access to the state DB or private version directory.
 * The parent namespace implementation owns proof that export occurred only
 * after joining the payload; PID/lease/JSON claims cannot substitute for it. */
export async function stageSupervisedAttemptCandidate(
  resourceId: string,
  options: Options = {},
): Promise<void> {
  const staged = readSupervisedWorkflow((db) => {
    const current = readCandidate(db, resourceId);
    assertCustodian(db, current, Date.now());
    return current;
  }, options);
  if (!staged) {
    throw new Error("Attempt resource store unavailable");
  }
  if (staged.row.state === "sealed") {
    return;
  }
  if (staged.row.state !== "decision") {
    throw new Error(
      "Candidate copy was already reserved; reconcile it without a second allocation",
    );
  }
  if (!staged.resource.plan.workspace) {
    writeSupervisedWorkflow((db) => {
      const current = readCandidate(db, resourceId);
      assertCustodian(db, current, Date.now());
      const updated = executeSqliteQuerySync(
        db,
        sql(db)
          .updateTable(TABLE)
          .set({ state: "sealed", sealed_at_ms: Date.now() })
          .where("resource_id", "=", resourceId)
          .where("state", "=", "decision"),
      );
      if (updated.numAffectedRows !== 1n) {
        throw new Error("Candidate stage conflict");
      }
    }, options);
    return;
  }
  const plan = staged.resource.plan;
  const exported = path.join(supervisedWorkspaceVersionPath(plan.allocationId, options), "export");
  if ((await fs.realpath(exported)) !== exported) {
    throw new Error("Attempt export traverses an alias");
  }
  const encoded = readSupervisedWorkflow(
    (db) => readSupervisedWorkflowContractInTransaction(db, plan.flowId, plan.episode),
    options,
  );
  if (!encoded || encoded.hash !== plan.workspace!.contractHash) {
    throw new Error("Attempt workflow changed");
  }
  const contract = { ...encoded.contract, workspace: exported };
  const snapshot = await captureSupervisedWorkspace(contract);
  const manifestJson = JSON.stringify(snapshot);
  decodeSnapshot(manifestJson);
  const versionId = writeSupervisedWorkflow((db) => {
    const current = readCandidate(db, resourceId);
    const task = assertCustodian(db, current, Date.now());
    if (current.row.state !== "decision") {
      throw new Error("Candidate copy already reserved");
    }
    const version = reserveSupervisedWorkspaceInTransaction(
      db,
      { kind: "attempt", task },
      "version",
      Date.now(),
    );
    executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable(TABLE)
        .set({ state: "preparing", version_id: version, manifest_json: manifestJson })
        .where("resource_id", "=", resourceId)
        .where("state", "=", "decision"),
    );
    return version;
  }, options);
  const copied = await cloneSupervisedWorkspaceSnapshot(
    contract,
    supervisedWorkspaceVersionPath(versionId, options),
    true,
  );
  if (JSON.stringify(copied) !== manifestJson) {
    throw new Error("Candidate copy did not match sealed export");
  }
  writeSupervisedWorkflow((db) => {
    const current = readCandidate(db, resourceId);
    assertCustodian(db, current, Date.now());
    if (current.row.version_id !== versionId || current.row.manifest_json !== manifestJson) {
      throw new Error("Candidate export changed");
    }
    const updated = executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable(TABLE)
        .set({ state: "sealed", sealed_at_ms: Date.now() })
        .where("resource_id", "=", resourceId)
        .where("state", "=", "preparing"),
    );
    if (updated.numAffectedRows !== 1n) {
      throw new Error("Candidate seal conflict");
    }
  }, options);
}

function consumedDisposition(current: ReturnType<typeof readCandidate>): SupervisedTask {
  if (!current.row.settled_task_json) {
    throw new Error("Consumed candidate is missing its disposition");
  }
  const result = validateSupervisedTask(JSON.parse(current.row.settled_task_json));
  if (
    result.flowId !== current.task.flowId ||
    result.episode !== current.task.episode ||
    result.revision !== current.task.revision + 1 ||
    result.lastAttemptId !== current.task.attempt?.id ||
    result.attempt !== null
  ) {
    throw new Error("Consumed candidate disposition does not match the staged attempt");
  }
  return result;
}

export type SupervisedAttemptSettlement = Readonly<{ kind: "committed-attempt-candidate" }>;
const settlements = new WeakMap<object, { expected: SupervisedTask; result: SupervisedTask }>();
function settlement(expected: SupervisedTask, result: SupervisedTask): SupervisedAttemptSettlement {
  const marker: SupervisedAttemptSettlement = Object.freeze({
    kind: "committed-attempt-candidate",
  });
  settlements.set(marker, { expected, result });
  return marker;
}

/** Worker-only one-shot observation, never a second semantic settlement. A JSON
 * object returned by the model cannot mint a host settlement marker. */
export function consumeSupervisedAttemptSettlement(
  value: object,
  expected: SupervisedTask,
): SupervisedTask | undefined {
  const stored = settlements.get(value);
  if (!stored) {
    return undefined;
  }
  settlements.delete(value);
  if (
    stored.expected.flowId !== expected.flowId ||
    stored.expected.episode !== expected.episode ||
    stored.expected.attempt?.id !== expected.attempt?.id ||
    stored.expected.revision !== expected.revision
  ) {
    throw new Error("Committed candidate belongs to another worker attempt");
  }
  return stored.result;
}

/** The only candidate consumption path. Verification awaits happen before a
 * synchronous write transaction which installs source AND settles the semantic
 * decision or durable operation wait AND records the consumed result. */
export async function acceptSupervisedAttemptCandidate(
  expected: SupervisedTask,
  resourceId: string,
  options: Options = {},
): Promise<SupervisedAttemptSettlement> {
  const staged = readSupervisedWorkflow((db) => {
    const current = readCandidate(db, resourceId);
    if (
      current.task.flowId !== expected.flowId ||
      current.task.episode !== expected.episode ||
      current.task.attempt?.id !== expected.attempt?.id ||
      current.task.revision !== expected.revision
    ) {
      throw new Error("Candidate does not belong to the expected worker attempt");
    }
    if (current.row.state === "consumed") {
      return current;
    }
    assertSource(db, current, Date.now());
    if (
      current.row.state !== "sealed" ||
      current.resource.state !== "closed" ||
      current.resource.revoked_at_ms === null ||
      current.resource.launcher_joined_at_ms === null
    ) {
      throw new Error("Candidate cannot be accepted before sealing and physical resource closure");
    }
    return current;
  }, options);
  if (!staged) {
    throw new Error("Attempt resource store unavailable");
  }
  // Lost response recovery is a read of the recorded disposition, even if a
  // successor has since advanced. It never re-installs an old workspace head.
  if (staged.row.state === "consumed") {
    const result = consumedDisposition(staged);
    return settlement(expected, result);
  }
  const encoded = readSupervisedWorkflow(
    (db) => readSupervisedWorkflowContractInTransaction(db, expected.flowId, expected.episode),
    options,
  );
  const candidateContract =
    encoded && staged.row.version_id
      ? {
          ...encoded.contract,
          workspace: supervisedWorkspaceVersionPath(staged.row.version_id, options),
        }
      : undefined;
  const assertCandidateBytes = async () => {
    if (!candidateContract) {
      return;
    }
    const snapshot = await captureSupervisedWorkspace(candidateContract);
    if (JSON.stringify(snapshot) !== staged.row.manifest_json) {
      throw new Error("Staged candidate bytes changed");
    }
  };
  await assertCandidateBytes();
  let decision: SupervisedDecision = staged.decision;
  let acceptance: SupervisedAcceptanceProof | undefined;
  if (decision.kind === "succeeded" || decision.kind === "partial") {
    const verified = await verifySupervisedWorkflowAcceptance(
      expected,
      decision,
      options,
      staged.row.version_id && staged.snapshot
        ? { versionId: staged.row.version_id, sourceHash: staged.snapshot.hash }
        : undefined,
    );
    if (verified.kind === "verified") {
      acceptance = verified.proof;
    } else if (verified.kind === "check") {
      decision = {
        kind: "operation",
        operation: {
          key: verified.key,
          kind: verified.profile.kind,
          profile: verified.profile.id,
          input: {},
        },
      };
    } else if (verified.kind === "rejected") {
      decision = verified.operatorRequired
        ? {
            kind: "input_required",
            reason: verified.reason,
            question: "Resolve the explicit acceptance requirement before resuming.",
          }
        : { kind: "continue", next: verified.reason };
    }
  }
  await assertCandidateBytes();
  const result = writeSupervisedWorkflow((db) => {
    const current = readCandidate(db, resourceId);
    // Another verifier may have committed while this caller awaited checks.
    // Replay the durable disposition before consulting now-revoked source authority.
    if (current.row.state === "consumed") {
      return consumedDisposition(current);
    }
    const task = assertSource(db, current, Date.now());
    if (
      current.row.state !== "sealed" ||
      current.resource.state !== "closed" ||
      current.resource.revoked_at_ms === null ||
      current.resource.launcher_joined_at_ms === null ||
      current.row.version_id !== staged.row.version_id ||
      current.row.manifest_json !== staged.row.manifest_json ||
      current.row.decision_json !== staged.row.decision_json
    ) {
      throw new Error("Candidate ownership changed during verification");
    }
    const now = Date.now();
    if (current.row.version_id && current.snapshot && current.resource.plan.workspace) {
      commitSupervisedWorkspaceVersionInTransaction(db, {
        flowId: task.flowId,
        episode: task.episode,
        expectedVersion: current.resource.plan.workspace.sourceVersion,
        version: current.row.version_id,
        snapshot: current.snapshot,
        now,
      });
    }
    const next =
      decision.kind === "operation"
        ? (enqueueSupervisedOperationInTransaction(db, task, decision.operation, now),
          readTask(db, task.flowId, task.episode)!)
        : settleSupervisedDecisionInTransaction(db, task, decision, now, acceptance);
    // Physical closure permits writer release; input-required retains scratch
    // for inspection. This exact plan links parent-owned draft to custodian-
    // owned version, rather than pretending their PID owners are identical.
    const updated = executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable("task_flow_workspace_allocations")
        .set({
          state: "released",
          updated_at_ms: now,
          ...(decision.kind !== "input_required" ? { discardable_at_ms: now } : {}),
        })
        .where("allocation_id", "=", current.resource.plan.allocationId)
        .where("flow_id", "=", task.flowId)
        .where("episode", "=", task.episode)
        .where("owner_kind", "=", "attempt")
        .where("owner_id", "=", task.attempt!.id)
        .where("owner_pid", "=", current.resource.plan.launcher.pid)
        .where("owner_start_time", "=", current.resource.plan.launcher.startTime)
        .where("kind", "=", "draft")
        .where("state", "=", "released"),
    );
    if (updated.numAffectedRows !== 1n) {
      throw new Error("Candidate draft no longer owns its exact physical reservation");
    }
    const consumed = executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable(TABLE)
        .set({ state: "consumed", consumed_at_ms: now, settled_task_json: JSON.stringify(next) })
        .where("resource_id", "=", resourceId)
        .where("state", "=", "sealed"),
    );
    if (consumed.numAffectedRows !== 1n) {
      throw new Error("Candidate consumption conflict");
    }
    return next;
  }, options);
  return settlement(expected, result);
}
