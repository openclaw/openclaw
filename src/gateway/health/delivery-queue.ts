import {
  countChannelIngressQueueHealth,
  type ChannelIngressQueueHealth,
} from "../../channels/message/ingress-queue-health.js";
import {
  captureDeliveryQueueStateContext,
  countFailedDeliveryQueueEntries,
  type DeliveryQueueStateContext,
} from "../../infra/delivery-queue-sqlite.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const healthLog = createSubsystemLogger("health");

function logQueueHealthReadFailure(message: string, error: unknown): void {
  if (isDiagnosticFlagEnabled("health")) {
    healthLog.info(message, { error: formatErrorMessage(error) });
  }
}

async function readQueueHealth<T>(
  message: string,
  read: () => T | Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    logQueueHealthReadFailure(message, error);
    return fallback;
  }
}

type DeliveryQueueHealthContext = { stateContext: DeliveryQueueStateContext } | { error: unknown };

export function captureDeliveryQueueHealthContext(): DeliveryQueueHealthContext {
  try {
    return { stateContext: captureDeliveryQueueStateContext() };
  } catch (error) {
    return { error };
  }
}

/** Builds redacted inbound pressure and dead-letter health for gateway snapshots. */
export async function buildDeliveryQueueHealthSummary(
  context: DeliveryQueueHealthContext = captureDeliveryQueueHealthContext(),
) {
  // Queue health reads are diagnostic; a storage failure must not take the
  // gateway health endpoint down with it.
  const failed = await readQueueHealth(
    "outbound delivery queue health read failed",
    () => {
      if ("error" in context) {
        throw context.error;
      }
      return countFailedDeliveryQueueEntries(undefined, context.stateContext);
    },
    [],
  );
  const stateContext = "stateContext" in context ? context.stateContext : undefined;
  const ingress = await readQueueHealth<ChannelIngressQueueHealth>(
    "channel ingress queue health read failed",
    () => countChannelIngressQueueHealth(stateContext?.stateDir, stateContext?.workerContext),
    { failed: [], pressure: [] },
  );
  if (ingress.errors?.failed) {
    logQueueHealthReadFailure(
      "channel ingress failed queue health read failed",
      ingress.errors.failed,
    );
  }
  if (ingress.errors?.pressure) {
    logQueueHealthReadFailure(
      "channel ingress pressure health read failed",
      ingress.errors.pressure,
    );
  }
  const { failed: ingressFailed, pressure: ingressPressure } = ingress;

  if (failed.length === 0 && ingressFailed.length === 0 && ingressPressure.length === 0) {
    return undefined;
  }
  return {
    failed,
    ...(ingressFailed.length > 0 ? { ingressFailed } : {}),
    ...(ingressPressure.length > 0 ? { ingressPressure } : {}),
  };
}
