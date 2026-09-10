import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  assertSupervisedOperationInTransaction,
  pinSupervisedOperationWorkspaceInTransaction,
} from "./supervised-operation.store.js";
import type { SupervisedOperationExecution } from "./supervised-operation.types.js";
import { assertSupervisedAttemptInTransaction } from "./supervised-task.store.js";
import type { SupervisedTask } from "./supervised-task.types.js";
import { assertSupervisedWorkflowRootInTransaction } from "./supervised-workflow-root.js";
import {
  readSupervisedWorkflow,
  writeSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";
import type { SupervisedWorkflowContract } from "./supervised-workflow.types.js";
import {
  createSupervisedWorkspaceDirectory,
  supervisedWorkspaceVersionPath,
} from "./supervised-workspace-path.js";
import {
  reserveSupervisedWorkspace,
  retainSupervisedWorkspaceInTransaction,
  markSupervisedWorkspaceDiscardableInTransaction,
  type SupervisedArtifactOwner,
} from "./supervised-workspace-retention.js";
import {
  captureSupervisedWorkspace,
  readSupervisedWorkspaceFile,
  type SupervisedWorkspaceSnapshot,
} from "./supervised-workspace.js";

export { supervisedWorkspaceVersionPath } from "./supervised-workspace-path.js";

const sql = (db: DatabaseSync) => getNodeSqliteKysely<DB>(db);
export function readSupervisedWorkspaceHeadInTransaction(
  db: DatabaseSync,
  flowId: string,
  episode: number,
) {
  if (!tableExists(db, "task_flow_workspace_heads")) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_workspace_heads as h")
      .innerJoin("task_flow_workspace_versions as v", "v.version_id", "h.version_id")
      .select(["v.version_id", "v.source_hash", "v.byte_count"])
      .where("h.flow_id", "=", flowId)
      .where("h.episode", "=", episode),
  );
}
export function getSupervisedWorkspaceHead(flowId: string, episode: number, options: Options = {}) {
  return readSupervisedWorkflow(
    (db) => readSupervisedWorkspaceHeadInTransaction(db, flowId, episode),
    options,
  );
}
export function resolveSupervisedWorkflowWorkspace(
  contract: SupervisedWorkflowContract,
  flowId: string,
  episode: number,
  options: Options = {},
) {
  const head = getSupervisedWorkspaceHead(flowId, episode, options);
  return {
    ...contract,
    workspace: head ? supervisedWorkspaceVersionPath(head.version_id, options) : contract.workspace,
  };
}

export async function cloneSupervisedWorkspaceSnapshot(
  contract: SupervisedWorkflowContract,
  directory: string,
  readonly: boolean,
) {
  const root = await fs.realpath(contract.workspace);
  if (directory === root || directory.startsWith(`${root}${path.sep}`)) {
    throw new Error("Private task artifacts must be outside the input workspace");
  }
  const snapshot = await captureSupervisedWorkspace(contract);
  await createSupervisedWorkspaceDirectory(directory);
  for (const file of snapshot.files) {
    const bytes = await readSupervisedWorkspaceFile(root, file.path, file.bytes);
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error("Source changed during private artifact copy");
    }
    const target = path.join(directory, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, bytes, {
      flag: "wx",
      mode: readonly ? (file.executable ? 0o500 : 0o400) : file.executable ? 0o700 : 0o600,
    });
  }
  if (
    (await captureSupervisedWorkspace(contract)).hash !== snapshot.hash ||
    (await captureSupervisedWorkspace({ ...contract, workspace: directory })).hash !== snapshot.hash
  ) {
    throw new Error("Private artifact does not match the frozen source");
  }
  return snapshot;
}

async function freezeSupervisedWorkspace(
  owner: SupervisedArtifactOwner,
  contract: SupervisedWorkflowContract,
  options: Options = {},
) {
  const version = reserveSupervisedWorkspace(owner, "version", Date.now(), options);
  const workspace = supervisedWorkspaceVersionPath(version, options);
  const snapshot = await cloneSupervisedWorkspaceSnapshot(contract, workspace, true);
  return { version, workspace, snapshot };
}
export function commitSupervisedWorkspaceVersionInTransaction(
  db: DatabaseSync,
  params: {
    flowId: string;
    episode: number;
    expectedVersion: string | null;
    version: string;
    snapshot: SupervisedWorkspaceSnapshot;
    now: number;
  },
) {
  const head = readSupervisedWorkspaceHeadInTransaction(db, params.flowId, params.episode);
  if ((head?.version_id ?? null) !== params.expectedVersion) {
    throw new Error("Workspace artifact ownership changed");
  }
  const bytes = params.snapshot.files.reduce((sum, file) => sum + file.bytes, 0);
  retainSupervisedWorkspaceInTransaction(
    db,
    params.version,
    params.flowId,
    params.episode,
    bytes,
    params.now,
  );
  executeSqliteQuerySync(
    db,
    sql(db).insertInto("task_flow_workspace_versions").values({
      version_id: params.version,
      flow_id: params.flowId,
      episode: params.episode,
      source_hash: params.snapshot.hash,
      byte_count: bytes,
      created_at_ms: params.now,
    }),
  );
  executeSqliteQuerySync(
    db,
    sql(db)
      .insertInto("task_flow_workspace_heads")
      .values({
        flow_id: params.flowId,
        episode: params.episode,
        version_id: params.version,
      })
      .onConflict((conflict) =>
        conflict.columns(["flow_id", "episode"]).doUpdateSet({ version_id: params.version }),
      ),
  );
}

/** Stale runtime writes remain in this attempt's private draft, never the accepted artifact. */
export async function ensureSupervisedAttemptSource(
  task: SupervisedTask,
  contract: SupervisedWorkflowContract,
  options: Options,
  assertCurrent: () => void,
) {
  let head = getSupervisedWorkspaceHead(task.flowId, task.episode, options);
  if (!head) {
    readSupervisedWorkflow(
      (db) =>
        assertSupervisedWorkflowRootInTransaction(
          db,
          task.flowId,
          task.episode,
          contract.workspace,
        ),
      options,
    );
    const initial = await freezeSupervisedWorkspace({ kind: "attempt", task }, contract, options);
    assertCurrent();
    writeSupervisedWorkflow((db) => {
      assertSupervisedAttemptInTransaction(db, task, Date.now());
      assertSupervisedWorkflowRootInTransaction(db, task.flowId, task.episode, contract.workspace);
      commitSupervisedWorkspaceVersionInTransaction(db, {
        flowId: task.flowId,
        episode: task.episode,
        expectedVersion: null,
        version: initial.version,
        snapshot: initial.snapshot,
        now: Date.now(),
      });
    }, options);
    head = getSupervisedWorkspaceHead(task.flowId, task.episode, options)!;
  }
  return head;
}

export async function prepareSupervisedAttemptWorkspace(
  task: SupervisedTask,
  contract: SupervisedWorkflowContract,
  options: Options,
  assertCurrent: () => void,
) {
  const head = await ensureSupervisedAttemptSource(task, contract, options, assertCurrent);
  const version = reserveSupervisedWorkspace(
    { kind: "attempt", task },
    "draft",
    Date.now(),
    options,
  );
  const workspace = supervisedWorkspaceVersionPath(version, options);
  await cloneSupervisedWorkspaceSnapshot(
    { ...contract, workspace: supervisedWorkspaceVersionPath(head.version_id, options) },
    workspace,
    false,
  );
  assertCurrent();
  return { workspace, baseVersion: head.version_id };
}

function scratchAllocation(workspace: string, options: Options, command: boolean) {
  const root =
    command && path.basename(workspace) === "export" ? path.dirname(workspace) : workspace;
  const allocationId = path.basename(root);
  if (supervisedWorkspaceVersionPath(allocationId, options) !== root) {
    throw new Error("Accepted source is not an owned scratch workspace");
  }
  return allocationId;
}

export async function acceptSupervisedAttemptWorkspace(
  task: SupervisedTask,
  contract: SupervisedWorkflowContract,
  draft: { workspace: string; baseVersion: string },
  options: Options,
  assertCurrent: () => void,
  disposition: { retainScratch?: boolean } = {},
) {
  const frozen = await freezeSupervisedWorkspace(
    { kind: "attempt", task },
    { ...contract, workspace: draft.workspace },
    options,
  );
  assertCurrent();
  writeSupervisedWorkflow((db) => {
    assertSupervisedAttemptInTransaction(db, task, Date.now());
    commitSupervisedWorkspaceVersionInTransaction(db, {
      flowId: task.flowId,
      episode: task.episode,
      expectedVersion: draft.baseVersion,
      version: frozen.version,
      snapshot: frozen.snapshot,
      now: Date.now(),
    });
    if (!disposition.retainScratch) {
      markSupervisedWorkspaceDiscardableInTransaction(
        db,
        frozen.version,
        scratchAllocation(draft.workspace, options, false),
        Date.now(),
      );
    }
  }, options);
}

export async function prepareSupervisedOperationWorkspace(
  execution: SupervisedOperationExecution,
  contract: SupervisedWorkflowContract,
  options: Options,
  writable: boolean,
  assertCurrent: () => void,
) {
  const operation = readSupervisedWorkflow(
    (db) => assertSupervisedOperationInTransaction(db, execution, Date.now()),
    options,
  )!;
  let head = getSupervisedWorkspaceHead(operation.flowId, operation.episode, options);
  if (!head) {
    readSupervisedWorkflow(
      (db) =>
        assertSupervisedWorkflowRootInTransaction(
          db,
          operation.flowId,
          operation.episode,
          contract.workspace,
        ),
      options,
    );
    const initial = await freezeSupervisedWorkspace(
      { kind: "operation", execution },
      contract,
      options,
    );
    assertCurrent();
    writeSupervisedWorkflow((db) => {
      assertSupervisedOperationInTransaction(db, execution, Date.now());
      assertSupervisedWorkflowRootInTransaction(
        db,
        operation.flowId,
        operation.episode,
        contract.workspace,
      );
      commitSupervisedWorkspaceVersionInTransaction(db, {
        flowId: operation.flowId,
        episode: operation.episode,
        expectedVersion: null,
        version: initial.version,
        snapshot: initial.snapshot,
        now: Date.now(),
      });
    }, options);
    head = getSupervisedWorkspaceHead(operation.flowId, operation.episode, options)!;
  }
  const baseVersion = operation.workspaceVersion ?? head.version_id;
  writeSupervisedWorkflow(
    (db) => pinSupervisedOperationWorkspaceInTransaction(db, execution, baseVersion, Date.now()),
    options,
  );
  let workspace = supervisedWorkspaceVersionPath(baseVersion, options);
  if (writable) {
    const draft = supervisedWorkspaceVersionPath(
      reserveSupervisedWorkspace({ kind: "operation", execution }, "draft", Date.now(), options),
      options,
    );
    await cloneSupervisedWorkspaceSnapshot({ ...contract, workspace }, draft, false);
    workspace = draft;
  }
  assertCurrent();
  return { contract: { ...contract, workspace }, baseVersion, headVersion: head.version_id };
}

export async function acceptSupervisedOperationWorkspace(
  execution: SupervisedOperationExecution,
  prepared: { contract: SupervisedWorkflowContract; baseVersion: string; headVersion: string },
  options: Options,
  assertCurrent: () => void,
  disposition: { retainScratch?: boolean } = {},
) {
  const frozen = await freezeSupervisedWorkspace(
    { kind: "operation", execution },
    prepared.contract,
    options,
  );
  assertCurrent();
  writeSupervisedWorkflow((db) => {
    const operation = assertSupervisedOperationInTransaction(db, execution, Date.now());
    commitSupervisedWorkspaceVersionInTransaction(db, {
      flowId: operation.flowId,
      episode: operation.episode,
      expectedVersion: prepared.headVersion,
      version: frozen.version,
      snapshot: frozen.snapshot,
      now: Date.now(),
    });
    if (!disposition.retainScratch) {
      markSupervisedWorkspaceDiscardableInTransaction(
        db,
        frozen.version,
        scratchAllocation(prepared.contract.workspace, options, true),
        Date.now(),
      );
    }
  }, options);
}
