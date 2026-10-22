/** Non-blocking process-owned queue for audit metadata persistence. */
import { randomUUID } from "node:crypto";
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import { resolveStateDir } from "../config/paths.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type {
  AgentRunFinishedAuditEventInput,
  AgentRunStartedAuditEventInput,
  AuditEventInput,
} from "./audit-event-types.js";
import {
  formatAuditWriterError,
  formatAuditWriterRequestError,
} from "./audit-event-writer.errors.js";
import type { AuditWriterRequest, AuditWriterResult } from "./audit-event-writer.types.js";
import type { AuditWriterOperations } from "./audit-event-writer.worker.js";
import { parseExecutionDecisionWork } from "./execution-decision-work.js";
import type { ExecutionDecisionWork } from "./execution-decision-work.types.js";
import type { ExecutionIdentityAdmissionWork } from "./execution-identity-admission.js";

const MAX_PENDING_AUDIT_EVENTS = 4_096;
const MAX_AUDIT_BATCH_SIZE = 32;
const MAX_CONSECUTIVE_UNKNOWN_OUTCOMES = 3;
const AUDIT_MAINTENANCE_INTERVAL_MS = 60 * 60_000;
const AUDIT_RETRY_DELAY_MS = 25;
const AUDIT_RETRY_MAX_DELAY_MS = 1_000;
const AUDIT_RETRY_REPORT_MS = 1_000;
const AUDIT_WRITER_SHUTDOWN_TIMEOUT_MS = OPENCLAW_SQLITE_BUSY_TIMEOUT_MS + 5_000;

type AuditMaintenanceAttempt = "settled" | "more" | "retry";

export type AuditEventWriter = {
  ready: Promise<void>;
  record: (input: AuditEventInput) => boolean;
  recordRun: (
    start: AgentRunStartedAuditEventInput,
    finish: AgentRunFinishedAuditEventInput,
  ) => boolean;
  /** Reports only queue acceptance; persistence succeeds or fails asynchronously. */
  recordExecutionIdentity: (work: ExecutionIdentityAdmissionWork) => boolean;
  /** For decision owners without a native durable record; approvals must not use this path. */
  recordExecutionDecision: (receipt: DecisionReceiptV1) => boolean;
  /** Raw private refs are projected only after this work reaches the FIFO owner. */
  recordExecutionDecisionWork: (work: ExecutionDecisionWork) => boolean;
  stop: () => Promise<void>;
};

/** Start one bounded queue; retain the owner environment or claimed state rejects its writes. */
export function createAuditEventWriter(options: {
  scheduler: GatewayScheduler;
  stateDir?: string;
  maxPending?: number;
  onContention?: (message: string) => void;
  onError?: (error: string) => void;
}): AuditEventWriter {
  const { scheduler } = options;
  const database = {
    env: { ...process.env, OPENCLAW_STATE_DIR: options.stateDir ?? resolveStateDir(process.env) },
  };
  const maxPending = Math.max(1, Math.floor(options.maxPending ?? MAX_PENDING_AUDIT_EVENTS));
  const queue: AuditWriterRequest[] = [];
  let pendingRows = 0;
  let stopped = false;
  let draining = false;
  let shutdownExpired = false;
  let maintenancePending = true;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempt = 0;
  let retryDelayMs = 0;
  let retryReported = false;
  let unknownBatch: { size: number; attempts: number } | undefined;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let stopPromise: Promise<void> | undefined;
  let resolveStop: (() => void) | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;

  const fail = (error: unknown) => {
    options.onError?.(formatAuditWriterError(error));
  };
  const reportContention = (message: string) => {
    options.onContention?.(formatAuditWriterError(message));
  };
  const execute = async <Key extends keyof AuditWriterOperations>(command: {
    type: Key;
    input: AuditWriterOperations[Key]["input"];
  }): Promise<AuditWriterOperations[Key]["output"] | undefined> => {
    const context = captureOpenClawStateWorkerContext(database);
    const { runOpenClawStateWorkerOperation } =
      await import("../state/openclaw-state-worker-store.js");
    if (shutdownExpired) {
      return undefined;
    }
    // Existing state opens lazily inside the audit command.
    const result = await runOpenClawStateWorkerOperation<
      AuditWriterOperations[Key]["output"] | undefined
    >(context, (scope) => (shutdownExpired ? Promise.resolve(undefined) : scope.execute(command)), {
      existingOnly: true,
    });
    if (result !== undefined || shutdownExpired) {
      return result;
    }
    return runOpenClawStateWorkerOperation<AuditWriterOperations[Key]["output"] | undefined>(
      context,
      (scope) => (shutdownExpired ? Promise.resolve(undefined) : scope.execute(command)),
    );
  };
  const resetRetry = () => {
    retryAttempt = 0;
    retryDelayMs = 0;
    retryReported = false;
  };
  const reportMaintenance = async (): Promise<AuditMaintenanceAttempt> => {
    let more = false;
    try {
      // A submitted pass settles all remaining bounded families even after the shutdown deadline.
      const results = await execute({ type: "audit.writer.prune", input: undefined });
      for (const result of results ?? []) {
        if (result.status === "retry") {
          retryAttempt += 1;
          return "retry";
        }
        if (result.error !== undefined) {
          fail(result.error);
        }
        more = (result.deleted ?? 0) > 0 || more;
      }
    } catch (error) {
      // A rejected transport can follow committed families; never replay an unknown pass.
      fail(error);
    }
    return more ? "more" : "settled";
  };
  const processRequests = async (requests: AuditWriterRequest[]): Promise<AuditWriterResult[]> => {
    try {
      const results = await execute({ type: "audit.writer.process", input: requests });
      unknownBatch = undefined;
      return results ?? requests.map(() => ({ status: "settled" as const }));
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        unknownBatch ??= { size: requests.length, attempts: 0 };
        unknownBatch.attempts += 1;
        fail(error);
        if (unknownBatch.attempts < MAX_CONSECUTIVE_UNKNOWN_OUTCOMES) {
          // Replay original IDs; committed items are no-ops.
          return [{ status: "retry" }];
        }
        // Drop a repeatedly crashing batch so later queued work can proceed.
        unknownBatch = undefined;
        return requests.map(() => ({ status: "settled" }));
      }
      unknownBatch = undefined;
      return requests.map((request) => ({
        status: "settled",
        error: formatAuditWriterRequestError(request, error),
      }));
    }
  };
  const finishStop = () => {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = undefined;
    }
    const finish = resolveStop;
    resolveStop = undefined;
    finish?.();
  };
  const schedule = () => {
    if (draining || shutdownExpired) {
      return;
    }
    if (retryTimer) {
      if (stopped) {
        retryTimer.ref?.();
      }
      return;
    }
    if (scheduled) {
      if (stopped) {
        scheduled.ref?.();
      }
      return;
    }
    scheduled = setImmediate(() => {
      void drainOne();
    });
    if (!stopped) {
      scheduled.unref?.();
    }
  };
  const scheduleRetry = () => {
    const delayMs = Math.min(
      AUDIT_RETRY_MAX_DELAY_MS,
      AUDIT_RETRY_DELAY_MS * 2 ** Math.min(6, retryAttempt - 1),
    );
    retryDelayMs += delayMs;
    if (!retryReported && retryDelayMs >= AUDIT_RETRY_REPORT_MS) {
      retryReported = true;
      reportContention("audit event persistence delayed by worker retries");
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void drainOne();
    }, delayMs);
    if (!stopped) {
      retryTimer.unref?.();
    }
  };
  async function drainOne() {
    scheduled = undefined;
    if (draining || shutdownExpired) {
      return;
    }
    draining = true;
    let retry = false;
    try {
      if (maintenancePending) {
        maintenancePending = false;
        const maintenance = await reportMaintenance();
        resolveReady();
        maintenancePending ||= maintenance !== "settled";
        if (maintenance === "retry") {
          retry = true;
          return;
        }
        resetRetry();
      }
      if (shutdownExpired) {
        return;
      }
      // Keep submitted items in the bounded queue until their native attempts settle.
      const requests = queue.slice(0, unknownBatch?.size ?? MAX_AUDIT_BATCH_SIZE);
      if (requests.length > 0) {
        const results = await processRequests(requests);
        retry = results.at(-1)?.status === "retry";
        const settled = results.length - (retry ? 1 : 0);
        // Release the whole settled prefix before an error observer can enqueue or throw.
        for (const request of queue.splice(0, settled)) {
          pendingRows -= request.type === "record-run" ? 2 : 1;
        }
        if (settled > 0) {
          resetRetry();
        }
        if (retry) {
          retryAttempt += 1;
        }
        for (const result of results) {
          if (result.status === "settled" && result.error !== undefined) {
            fail(result.error);
          }
        }
      }
    } finally {
      draining = false;
      if (shutdownExpired) {
        finishStop();
      } else if (retry) {
        scheduleRetry();
      } else if (queue.length > 0 || maintenancePending) {
        schedule();
      } else if (stopped) {
        finishStop();
      }
    }
  }
  const maintenanceJob = scheduler.schedule({
    id: "audit:maintenance",
    atMs: scheduler.now() + AUDIT_MAINTENANCE_INTERVAL_MS,
    everyMs: AUDIT_MAINTENANCE_INTERVAL_MS,
    run: () => {
      maintenancePending = true;
      schedule();
    },
  });
  schedule();

  const enqueue = (message: AuditWriterRequest): boolean => {
    const rows = message.type === "record-run" ? 2 : 1;
    if (stopped || pendingRows + rows > maxPending) {
      if (!stopped) {
        fail(`audit event queue is full (${maxPending}); dropping metadata`);
      }
      return false;
    }
    try {
      const boundedMessage =
        message.type === "record-execution-decision-work"
          ? { ...message, work: parseExecutionDecisionWork(message.work) }
          : message;
      // Preserve the former Worker boundary's clone and prototype-stripping contract.
      queue.push(structuredClone(boundedMessage));
      pendingRows += rows;
      schedule();
      return true;
    } catch (error) {
      if (message.type !== "record-event" && message.type !== "record-run") {
        fail(
          message.type === "record-execution-identity"
            ? "audit execution identity envelope could not be queued"
            : "audit execution decision receipt could not be queued",
        );
      } else {
        fail(error);
      }
      return false;
    }
  };

  return {
    ready,
    record: (input) => enqueue({ type: "record-event", eventId: randomUUID(), input }),
    recordRun: (start, finish) =>
      enqueue({ type: "record-run", start, finish, eventIds: [randomUUID(), randomUUID()] }),
    recordExecutionIdentity: (work) => enqueue({ type: "record-execution-identity", work }),
    recordExecutionDecision: (receipt) => enqueue({ type: "record-execution-decision", receipt }),
    recordExecutionDecisionWork: (work) =>
      enqueue({ type: "record-execution-decision-work", work }),
    stop: () => {
      if (stopPromise) {
        return stopPromise;
      }
      stopped = true;
      maintenanceJob.cancel();
      maintenancePending = true;
      stopPromise = new Promise<void>((resolve) => {
        resolveStop = resolve;
        stopTimer = setTimeout(() => {
          shutdownExpired = true;
          maintenancePending = false;
          queue.length = 0;
          pendingRows = 0;
          if (scheduled) {
            clearImmediate(scheduled);
            scheduled = undefined;
          }
          if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = undefined;
          }
          fail("audit event writer shutdown timed out; pending metadata may be lost");
          // The deadline drops waiting metadata, but a submitted mutation must settle.
          if (!draining) {
            resolveReady();
            finishStop();
          }
        }, AUDIT_WRITER_SHUTDOWN_TIMEOUT_MS);
        stopTimer.unref?.();
        schedule();
      });
      return stopPromise;
    },
  };
}
