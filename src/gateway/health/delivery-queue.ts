import {
  countChannelIngressQueuePressure,
  countFailedChannelIngressQueueEntries,
} from "../../channels/message/ingress-queue-health.js";
import {
  captureDeliveryQueueStateContext,
  countFailedDeliveryQueueEntries,
  type DeliveryQueueStateContext,
} from "../../infra/delivery-queue-sqlite.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const healthLog = createSubsystemLogger("health");

async function readQueueHealth<T>(
  message: string,
  read: () => T[] | Promise<T[]>,
  onFailure?: () => void,
): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    onFailure?.();
    if (isDiagnosticFlagEnabled("health")) {
      healthLog.info(message, { error: formatErrorMessage(error) });
    }
    return [];
  }
}

type DeliveryQueueHealthContext = { stateContext: DeliveryQueueStateContext } | { error: unknown };

type FailedQueueHealth = {
  failed: Awaited<ReturnType<typeof countFailedDeliveryQueueEntries>>;
};
let failedQueueHealthCache: (FailedQueueHealth & { writeToken: string }) | undefined;

async function readFailedQueueHealth(
  context: DeliveryQueueHealthContext,
): Promise<FailedQueueHealth> {
  const writeToken =
    "stateContext" in context
      ? readSqliteDatabaseWriteTokenForPath(
          context.stateContext.workerContext.admission.databasePath,
        )
      : undefined;
  if (writeToken && failedQueueHealthCache?.writeToken === writeToken) {
    return failedQueueHealthCache;
  }
  let failedRead = false;
  const onFailure = () => {
    failedRead = true;
  };
  const failed = await readQueueHealth(
    "outbound delivery queue health read failed",
    () => {
      if ("error" in context) {
        throw context.error;
      }
      return countFailedDeliveryQueueEntries(undefined, context.stateContext);
    },
    onFailure,
  );
  const health = { failed };
  if (writeToken && !failedRead) {
    // Keep the pre-read token: a write during the reads invalidates the next snapshot.
    failedQueueHealthCache = { ...health, writeToken };
  }
  return health;
}

export function captureDeliveryQueueHealthContext(): DeliveryQueueHealthContext {
  try {
    return { stateContext: captureDeliveryQueueStateContext() };
  } catch (error) {
    return { error };
  }
}

/** Builds redacted inbound pressure and dead-letter health for gateway snapshots. */
export async function buildDeliveryQueueHealthSummary(
  cachedIngressPressure?: Awaited<ReturnType<typeof countChannelIngressQueuePressure>>,
  context: DeliveryQueueHealthContext = captureDeliveryQueueHealthContext(),
) {
  // Queue health reads are diagnostic; a storage failure must not take the
  // gateway health endpoint down with it.
  const { failed } = await readFailedQueueHealth(context);
  const stateContext = "stateContext" in context ? context.stateContext : undefined;
  const ingressFailed = await readQueueHealth(
    "channel ingress failed queue health read failed",
    () =>
      countFailedChannelIngressQueueEntries(stateContext?.stateDir, stateContext?.workerContext),
  );
  const ingressPressure =
    cachedIngressPressure ??
    (await readQueueHealth("channel ingress pressure health read failed", () =>
      countChannelIngressQueuePressure(stateContext?.stateDir, stateContext?.workerContext),
    ));

  if (failed.length === 0 && ingressFailed.length === 0 && ingressPressure.length === 0) {
    return undefined;
  }
  return {
    failed,
    ...(ingressFailed.length > 0 ? { ingressFailed } : {}),
    ...(ingressPressure.length > 0 ? { ingressPressure } : {}),
  };
}
