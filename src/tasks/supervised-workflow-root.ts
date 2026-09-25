import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { SupervisedTask } from "./supervised-task.types.js";

const sql = (db: DatabaseSync) => getNodeSqliteKysely<DB>(db);
type Root = Pick<DB["task_flow_workspace_roots"], "canonical_path" | "device" | "inode">;

function inspectRoot(workspace: string): Root {
  try {
    const canonical = fs.realpathSync(workspace);
    const stat = fs.lstatSync(workspace, { bigint: true });
    // Reject aliases rather than rewriting a host-accepted capability and its hash.
    if (canonical !== workspace || !stat.isDirectory()) {
      throw new Error("Noncanonical workspace directory");
    }
    return { canonical_path: canonical, device: stat.dev.toString(), inode: stat.ino.toString() };
  } catch {
    throw new Error("Workspace must be an existing canonical directory");
  }
}

function assertRoot(root: Root): void {
  let observed: Root;
  try {
    observed = inspectRoot(root.canonical_path);
  } catch {
    throw new Error("Workspace root identity changed or is unavailable");
  }
  if (observed.device !== root.device || observed.inode !== root.inode) {
    throw new Error("Workspace root identity changed");
  }
}

/** Recheck the admitted input before IO and in the transaction accepting its
 * initial copy. Once a private head exists, that artifact owns continuation. */
export function assertSupervisedWorkflowRootInTransaction(
  db: DatabaseSync,
  flowId: string,
  episode: number,
  expectedWorkspace: string,
): void {
  const root = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_workspace_roots")
      .selectAll()
      .where("flow_id", "=", flowId)
      .where("episode", "=", episode),
  );
  if (!root) {
    throw new Error("Accepted workspace root identity is missing");
  }
  if (root.canonical_path !== expectedWorkspace) {
    throw new Error("Workspace root changed from its accepted contract");
  }
  assertRoot(root);
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** The task/contract/root are inserted by the same synchronous transaction.
 * Ownership outlives logical endpoints while process or resource custody remains. */
export function insertSupervisedWorkflowRootInTransaction(
  db: DatabaseSync,
  task: SupervisedTask,
  workspace: string,
): void {
  let root: Root;
  if (task.episode > 1) {
    const previous = executeSqliteQueryTakeFirstSync(
      db,
      sql(db)
        .selectFrom("task_flow_workspace_roots")
        .selectAll()
        .where("flow_id", "=", task.flowId)
        .where("episode", "=", task.episode - 1),
    );
    if (!previous || previous.canonical_path !== workspace) {
      throw new Error("Resume requires the original accepted workspace root identity");
    }
    root = previous;
    const head = executeSqliteQueryTakeFirstSync(
      db,
      sql(db)
        .selectFrom("task_flow_workspace_heads")
        .select("version_id")
        .where("flow_id", "=", task.flowId)
        .where("episode", "=", task.episode - 1),
    );
    if (!head) {
      assertRoot(root);
    }
  } else {
    root = inspectRoot(workspace);
  }

  const held = executeSqliteQuerySync(
    db,
    sql(db)
      .selectFrom("task_flow_contracts as c")
      .innerJoin("task_flow_episodes as e", (join) =>
        join.onRef("e.flow_id", "=", "c.flow_id").onRef("e.episode", "=", "c.episode"),
      )
      .leftJoin("task_flow_workspace_roots as r", (join) =>
        join.onRef("r.flow_id", "=", "c.flow_id").onRef("r.episode", "=", "c.episode"),
      )
      .select(["c.workspace", "r.canonical_path", "r.device", "r.inode"])
      .where((eb) =>
        eb.or([
          eb.and([
            eb("c.flow_id", "!=", task.flowId),
            eb("e.phase", "in", ["ready", "waiting", "running", "input_required"]),
            eb.not(
              eb.exists(
                eb
                  .selectFrom("task_flow_episodes as later")
                  .select("later.episode")
                  .whereRef("later.flow_id", "=", "e.flow_id")
                  .whereRef("later.episode", ">", "e.episode"),
              ),
            ),
          ]),
          eb.exists(
            eb
              .selectFrom("task_flow_attempt_resources as attempt_resource")
              .select("attempt_resource.resource_id")
              .whereRef("attempt_resource.flow_id", "=", "c.flow_id")
              .whereRef("attempt_resource.episode", "=", "c.episode")
              .where("attempt_resource.state", "!=", "closed"),
          ),
          eb.exists(
            eb
              .selectFrom("task_flow_operations as o")
              .leftJoin("task_flow_operation_executions as x", "x.operation_id", "o.operation_id")
              .leftJoin("task_flow_operation_launches as l", "l.execution_id", "x.execution_id")
              .leftJoin(
                "task_flow_command_resources as resources",
                "resources.execution_id",
                "x.execution_id",
              )
              .select("o.operation_id")
              .whereRef("o.flow_id", "=", "c.flow_id")
              .whereRef("o.episode", "=", "c.episode")
              .where((op) =>
                op.or([
                  op("o.state", "in", ["queued", "running", "reconciling"]),
                  op("l.state", "in", ["reserved", "spawned"]),
                  op("resources.state", "!=", "closed"),
                ]),
              ),
          ),
        ]),
      ),
  ).rows;
  for (const owner of held) {
    // Never stat an old pathname to reconstruct ownership: it may have moved
    // or been replaced. The admission-time identity remains authoritative.
    if (owner.canonical_path === null || owner.device === null || owner.inode === null) {
      throw new Error(
        "Workspace root custody reconciliation required: admitted identity is missing",
      );
    }
    if (
      contains(owner.canonical_path, root.canonical_path) ||
      contains(root.canonical_path, owner.canonical_path) ||
      (owner.device === root.device && owner.inode === root.inode)
    ) {
      throw new Error("Workspace already has an active supervised writer");
    }
    try {
      assertRoot({
        canonical_path: owner.canonical_path,
        device: owner.device,
        inode: owner.inode,
      });
    } catch {
      // A moved descendant may now overlap the new root even when neither
      // persisted paths nor the two root inodes match. Do not guess its location.
      throw new Error(
        "Workspace root custody reconciliation required: an occupied root moved or is unavailable",
      );
    }
  }
  executeSqliteQuerySync(
    db,
    sql(db).insertInto("task_flow_workspace_roots").values({
      flow_id: task.flowId,
      episode: task.episode,
      canonical_path: root.canonical_path,
      device: root.device,
      inode: root.inode,
    }),
  );
}
