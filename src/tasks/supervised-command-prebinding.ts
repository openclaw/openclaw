import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { inspectNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { getSupervisedCommandResources } from "./supervised-command-custody.js";
import { isSealedSupervisedCommandScopeAbsent } from "./supervised-command-resources.js";
import { readSupervisedProcessHostIdentity } from "./supervised-process-resources.js";
import {
  writeSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";

/** No unit-name signaling and no inferred transport extinction. Legacy NULL
 * plans and started transports with no extinction evidence remain held. */
export async function reconcileSupervisedCommandPrebinding(
  executionId: string,
  assertCurrent: () => void,
  options: Options = {},
): Promise<void> {
  assertCurrent();
  const resource = getSupervisedCommandResources(executionId, options);
  if (!resource?.prebinding || !["planned", "sealed"].includes(resource.state)) {
    return;
  }
  const plan = resource.prebinding;
  const encoded = resource.identity_json;
  const host = readSupervisedProcessHostIdentity();
  if (host.hostId !== plan.hostId) {
    throw new Error("Command prebinding belongs to another host");
  }
  const bootRetired = host.bootId !== plan.bootId;
  const owner = bootRetired ? "dead" : inspectNodeWorkerProcessIdentity(plan.launcher);
  // An expired execution lease or absence now does not imply a dead launcher.
  if (!bootRetired && owner !== "dead" && owner !== "reused" && plan.transport !== "extinct") {
    return;
  }
  const sealed = writeSupervisedWorkflow((db) => {
    assertCurrent();
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("task_flow_command_resources")
        .selectAll()
        .where("execution_id", "=", executionId),
    );
    if (!row || row.identity_json !== encoded || !["planned", "sealed"].includes(row.state)) {
      return false;
    }
    // This CAS prevents a previously admitted but resumed launcher from
    // consuming not_started after recovery decides it cannot have spawned.
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .updateTable("task_flow_command_resources")
        .set({ state: "sealed", updated_at_ms: Date.now() })
        .where("execution_id", "=", executionId)
        .where("identity_json", "=", encoded)
        .where("state", "in", ["planned", "sealed"]),
    );
    return true;
  }, options);
  if (!sealed) {
    return;
  }
  if (!bootRetired && plan.transport === "started") {
    return;
  }
  // not_started cannot have handed a request to systemd. Changed boot proves
  // extinction of its entire old transport. Otherwise require the persisted
  // required-all callback AND a sealed missing-unit observation.
  if (
    !bootRetired &&
    plan.transport === "extinct" &&
    !(await isSealedSupervisedCommandScopeAbsent(executionId))
  ) {
    return;
  }
  assertCurrent();
  writeSupervisedWorkflow((db) => {
    assertCurrent();
    const currentHost = readSupervisedProcessHostIdentity();
    if (currentHost.hostId !== host.hostId || currentHost.bootId !== host.bootId) {
      throw new Error("Command prebinding recovery host changed");
    }
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .updateTable("task_flow_command_resources")
        .set({ state: "closed", updated_at_ms: Date.now() })
        .where("execution_id", "=", executionId)
        .where("state", "=", "sealed")
        .where("identity_json", "=", encoded),
    );
  }, options);
}
