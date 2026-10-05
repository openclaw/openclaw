import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WorkerEnvironmentRecord } from "./store.js";

const log = createSubsystemLogger("gateway/worker-provision");

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
