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
  onFailure: () => void,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    onFailure();
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
  const stateContext = "stateContext" in context ? context.stateContext : undefined;
  const unavailable = new Set<"outbound" | "ingressFailed" | "ingressPressure">();
  const [failed, ingress] = await Promise.all([
    readQueueHealth(
      "outbound delivery queue health read failed",
      () => {
        if ("error" in context) {
          throw context.error;
        }
        return countFailedDeliveryQueueEntries(undefined, context.stateContext);
      },
      [],
      () => {
        unavailable.add("outbound");
      },
    ),
    readQueueHealth<ChannelIngressQueueHealth>(
      "channel ingress queue health read failed",
      () => {
        if ("error" in context) {
          throw context.error;
        }
        return countChannelIngressQueueHealth(stateContext?.stateDir, stateContext?.workerContext);
      },
      { failed: [], pressure: [] },
      () => {
        unavailable.add("ingressFailed");
        unavailable.add("ingressPressure");
      },
    ),
  ]);
  if (ingress.errors?.failed !== undefined) {
    unavailable.add("ingressFailed");
    logQueueHealthReadFailure(
      "channel ingress failed queue health read failed",
      ingress.errors.failed,
    );
  }
  if (ingress.errors?.pressure !== undefined) {
    unavailable.add("ingressPressure");
    logQueueHealthReadFailure(
      "channel ingress pressure health read failed",
      ingress.errors.pressure,
    );
  }
  const { failed: ingressFailed, pressure: ingressPressure } = ingress;

  if (
    failed.length === 0 &&
    ingressFailed.length === 0 &&
    ingressPressure.length === 0 &&
    unavailable.size === 0
  ) {
    return undefined;
  }
  return {
    failed,
    ...(unavailable.size > 0 ? { unavailable: [...unavailable].toSorted() } : {}),
    ...(ingressFailed.length > 0 ? { ingressFailed } : {}),
    ...(ingressPressure.length > 0 ? { ingressPressure } : {}),
  };
}
