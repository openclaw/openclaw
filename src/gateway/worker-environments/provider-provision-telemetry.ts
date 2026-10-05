import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WorkerEnvironmentRecord } from "./store.js";

const log = createSubsystemLogger("gateway/worker-provision");

/** Observe the controller's actual producer before aborting; never publish its reason text. */
export function reportWorkerProvisionAbort(
  record: Pick<WorkerEnvironmentRecord, "environmentId" | "provisionOperationId" | "ownerEpoch">,
  owner: "runtime-operation" | "node-enrollment",
  cause:
    | "caller-signal"
    | "operation-closed"
    | "host-stopping"
    | "owner-changed"
    | "destroy-requested"
    | "preparation-expired"
    | "binding-replaced"
    | "binding-closed"
    | "environment-retired",
  controllerSignal: AbortSignal,
) {
  if (controllerSignal.aborted) {
    return;
  }
  try {
    log.info("worker provision abort owner", {
      environmentId: record.environmentId,
      provisionOperationId: record.provisionOperationId,
      ownerEpoch: record.ownerEpoch,
      owner,
      cause,
    });
  } catch {
    // This receipt cannot change the abort or the original failure.
  }
}

/** Emit one start and one terminal event per owned stage; error text is never telemetry. */
export async function withWorkerProvisionStage<T>(
  record: Pick<
    WorkerEnvironmentRecord,
    "environmentId" | "provisionOperationId" | "leaseId" | "attachedSessionIds"
  >,
  stage: string,
  run: () => Promise<T>,
  leaseId = record.leaseId,
): Promise<T> {
  const startedAt = performance.now();
  const identity = {
    environmentId: record.environmentId,
    provisionOperationId: record.provisionOperationId,
    leaseId,
    sessionId: record.attachedSessionIds[0] ?? null,
    stage,
  };
  log.info("worker provision stage", { ...identity, elapsedMs: 0, outcome: "started" });
  try {
    const result = await run();
    log.info("worker provision stage", {
      ...identity,
      elapsedMs: Math.round(performance.now() - startedAt),
      outcome: "completed",
    });
    return result;
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    log.warn("worker provision stage", {
      ...identity,
      elapsedMs: Math.round(performance.now() - startedAt),
      outcome: "failed",
      errorCode: /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : "unknown",
    });
    throw error;
  }
}
