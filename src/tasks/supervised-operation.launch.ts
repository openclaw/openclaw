import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { requireNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  observeSupervisedOperationProcess,
  recordSupervisedOperationBootstrapExited,
  recordSupervisedOperationNotSpawned,
} from "./supervised-operation.capacity.js";
import {
  claimSupervisedOperation,
  releaseSupervisedOperationForReconciliation,
} from "./supervised-operation.store.js";
import type { SupervisedWorkflowDatabaseOptions } from "./supervised-workflow.persistence.js";

/** Spawn acknowledgement is not custody or completion; readers inspect SQL. */
export async function launchSupervisedOperationProcess(
  operationId: string,
  options: SupervisedWorkflowDatabaseOptions = {},
): Promise<void> {
  const launcher = requireNodeWorkerProcessIdentity(process.pid);
  const execution = claimSupervisedOperation(
    operationId,
    randomUUID(),
    Date.now(),
    options,
    launcher,
  );
  if (!execution) {
    return;
  }
  let spawned = false;
  try {
    const databasePath =
      options.database?.path ?? options.path ?? resolveOpenClawStateSqlitePath(options.env);
    const argv = [
      ...resolveRuntimeWorkerArgv(resolveRuntimeProcessEntrypointUrl("supervisedOperation")),
      "--supervised-operation",
      operationId,
      execution.executionId,
      databasePath,
    ];
    // No IPC/control parent channel and no coordinator-owned child group anchor.
    // SQL owns the execution and physical capacity before any process is spawned.
    const child = spawn(process.execPath, argv, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...options.env },
    });
    child.once("exit", () => {
      try {
        recordSupervisedOperationBootstrapExited(
          execution.executionId,
          launcher,
          Date.now(),
          options,
        );
      } catch {
        // Storage failure cannot turn unknown custody into free capacity.
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => {
        spawned = true;
        resolve();
      });
    });
    child.unref();
    if (child.pid) {
      observeSupervisedOperationProcess(
        execution.executionId,
        requireNodeWorkerProcessIdentity(child.pid),
        Date.now(),
        options,
      );
    }
  } catch (error) {
    if (!spawned) {
      recordSupervisedOperationNotSpawned(execution.executionId, launcher, Date.now(), options);
      releaseSupervisedOperationForReconciliation(execution, Date.now(), options);
    }
    // After spawn, failure to observe identity is uncertainty, not free capacity.
    throw error;
  }
}
