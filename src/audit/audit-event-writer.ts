/** Non-blocking process-owned queue for audit metadata persistence. */
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import { resolveStateDir } from "../config/paths.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { AuditEventInput } from "./audit-event-types.js";
import {
  formatAuditWriterError,
  formatAuditWriterRequestError,
} from "./audit-event-writer.errors.js";
import type {
  AuditWriterOperations,
  AuditWriterRequest,
  AuditWriterResult,
} from "./audit-event-writer.types.js";
import { parseExecutionDecisionWork } from "./execution-decision-work.js";
import type { ExecutionDecisionWork } from "./execution-decision-work.types.js";
import type { ExecutionIdentityAdmissionWork } from "./execution-identity-admission.js";

const MAX_PENDING_AUDIT_EVENTS = 4_096;
const AUDIT_MAINTENANCE_INTERVAL_MS = 60 * 60_000;
const AUDIT_LOCK_RETRY_DELAY_MS = 25;
const AUDIT_LOCK_RETRY_MAX_DELAY_MS = 1_000;
const AUDIT_LOCK_CONTENTION_REPORT_MS = 1_000;
const AUDIT_WRITER_SHUTDOWN_TIMEOUT_MS = OPENCLAW_SQLITE_BUSY_TIMEOUT_MS + 5_000;

type AuditMaintenanceAttempt = "settled" | "more" | "retry";

export type AuditEventWriter = {
  ready: Promise<void>;
  record: (input: AuditEventInput) => boolean;
  /** Reports only queue acceptance; persistence succeeds or fails asynchronously. */
  recordExecutionIdentity: (work: ExecutionIdentityAdmissionWork) => boolean;
  /** For decision owners without a native durable record; approvals must not use this path. */
  recordExecutionDecision: (receipt: DecisionReceiptV1) => boolean;
  /** Raw private refs are projected only after this work reaches the FIFO owner. */
  recordExecutionDecisionWork: (work: ExecutionDecisionWork) => boolean;
  stop: () => Promise<void>;
};

/** Start one bounded queue; retain the owner environment or claimed state rejects its writes. */
export function createAuditEventWriter(
  options: {
    stateDir?: string;
    maxPending?: number;
    onContention?: (message: string) => void;
    onError?: (error: string) => void;
  } = {},
): AuditEventWriter {
  const database = {
    env: { ...process.env, OPENCLAW_STATE_DIR: options.stateDir ?? resolveStateDir(process.env) },
  };
  const maxPending = Math.max(1, Math.floor(options.maxPending ?? MAX_PENDING_AUDIT_EVENTS));
  const queue: AuditWriterRequest[] = [];
  let stopped = false;
  let draining = false;
  let shutdownExpired = false;
  let unavailable = false;
  let maintenancePending = true;
  let readyPending = true;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lockRetryAttempt = 0;
  let lockContentionDelayMs = 0;
  let lockContentionReported = false;
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
  const execute = async (
    command: SqliteWorkerCommand<AuditWriterOperations>,
  ): Promise<AuditWriterResult> => {
    const context = captureOpenClawStateWorkerContext(database);
    const { runOpenClawStateWorkerOperation } =
      await import("../state/openclaw-state-worker-store.js");
    if (shutdownExpired) {
      return { status: "settled" };
    }
    // Existing state opens lazily inside the zero-busy-timeout audit command.
    const result = await runOpenClawStateWorkerOperation<AuditWriterResult>(
      context,
      (scope) =>
        shutdownExpired ? Promise.resolve({ status: "settled" } as const) : scope.execute(command),
      { existingOnly: true },
    );
    return (
      result ??
      runOpenClawStateWorkerOperation<AuditWriterResult>(context, (scope) =>
        shutdownExpired ? Promise.resolve({ status: "settled" } as const) : scope.execute(command),
      )
    );
  };
  const observeLockContention = () => {
    lockRetryAttempt += 1;
  };
  const resetLockContention = () => {
    lockRetryAttempt = 0;
    lockContentionDelayMs = 0;
    lockContentionReported = false;
  };
  const reportMaintenance = async (): Promise<AuditMaintenanceAttempt> => {
    let more = false;
    for (const family of ["events", "identity", "decisions", "progress"] as const) {
      if (shutdownExpired) {
        break;
      }
      try {
        const result = await execute({ type: "audit.writer.prune", input: family });
        if (result.status === "retry") {
          observeLockContention();
          return "retry";
        }
        if (result.error !== undefined) {
          fail(result.error);
        }
        more = (result.deleted ?? 0) > 0 || more;
      } catch (error) {
        fail(error);
      }
    }
    return more ? "more" : "settled";
  };
  const processRequest = async (request: AuditWriterRequest): Promise<AuditWriterResult> => {
    try {
      return await execute({ type: "audit.writer.process", input: request });
    } catch (error) {
      // Rejected transport/settlement can follow a commit; never replay that request.
      return { status: "settled", error: formatAuditWriterRequestError(request, error) };
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
      AUDIT_LOCK_RETRY_MAX_DELAY_MS,
      AUDIT_LOCK_RETRY_DELAY_MS * 2 ** Math.min(6, Math.max(0, lockRetryAttempt - 1)),
    );
    lockContentionDelayMs += delayMs;
    if (!lockContentionReported && lockContentionDelayMs >= AUDIT_LOCK_CONTENTION_REPORT_MS) {
      lockContentionReported = true;
      reportContention("audit event persistence delayed by SQLite lock contention");
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
        if (readyPending) {
          readyPending = false;
          resolveReady();
        }
        maintenancePending ||= maintenance !== "settled";
        if (maintenance === "retry") {
          retry = true;
          return;
        }
        resetLockContention();
      }
      if (shutdownExpired) {
        return;
      }
      // Keep the in-flight head in the bounded queue until native settlement.
      const request = queue[0];
      if (request) {
        const result = await processRequest(request);
        if (result.status === "retry") {
          observeLockContention();
          retry = true;
        } else {
          // Release settled capacity before an error observer can enqueue or throw.
          queue.shift();
          resetLockContention();
          if (result.error !== undefined) {
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
  const maintenanceTimer = setInterval(() => {
    maintenancePending = true;
    schedule();
  }, AUDIT_MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref?.();
  schedule();

  const enqueue = (message: AuditWriterRequest): boolean => {
    if (stopped || unavailable || queue.length >= maxPending) {
      if (!stopped) {
        fail(
          unavailable
            ? "audit event writer is unavailable; dropping metadata"
            : `audit event queue is full (${maxPending}); dropping metadata`,
        );
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
      schedule();
      return true;
    } catch (error) {
      if (message.type !== "record-event") {
        fail(
          message.type === "record-execution-identity"
            ? "audit execution identity envelope could not be queued"
            : "audit execution decision receipt could not be queued",
        );
      } else {
        unavailable = true;
        fail(error);
      }
      return false;
    }
  };

  return {
    ready,
    record: (input) => enqueue({ type: "record-event", input }),
    recordExecutionIdentity: (work) => enqueue({ type: "record-execution-identity", work }),
    recordExecutionDecision: (receipt) => enqueue({ type: "record-execution-decision", receipt }),
    recordExecutionDecisionWork: (work) =>
      enqueue({ type: "record-execution-decision-work", work }),
    stop: () => {
      if (stopPromise) {
        return stopPromise;
      }
      stopped = true;
      clearInterval(maintenanceTimer);
      maintenancePending = true;
      stopPromise = new Promise<void>((resolve) => {
        resolveStop = resolve;
        stopTimer = setTimeout(() => {
          shutdownExpired = true;
          maintenancePending = false;
          queue.length = 0;
          if (scheduled) {
            clearImmediate(scheduled);
            scheduled = undefined;
          }
          if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = undefined;
          }
          fail("audit event writer shutdown timed out; pending metadata may be lost");
          if (readyPending && !draining) {
            readyPending = false;
            resolveReady();
          }
          // The deadline drops waiting metadata, but a submitted mutation must settle.
          if (!draining) {
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
