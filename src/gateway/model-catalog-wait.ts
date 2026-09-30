import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  GatewayErrorDetailCodes,
} from "../../packages/gateway-protocol/src/index.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";

const MODEL_CATALOG_WAIT_MS = 30_000;
const MODEL_CATALOG_LOADING_MESSAGE = "Models are still loading; retry in a moment.";

/** The one wire shape for a request that gave up waiting on the published model catalog. */
export function modelCatalogLoadingError(): ErrorShape {
  return errorShape(ErrorCodes.UNAVAILABLE, MODEL_CATALOG_LOADING_MESSAGE, {
    retryable: true,
    details: { code: GatewayErrorDetailCodes.MODEL_CATALOG_LOADING },
  });
}

export class ModelCatalogLoadingError extends Error {
  constructor() {
    super(MODEL_CATALOG_LOADING_MESSAGE);
    this.name = "ModelCatalogLoadingError";
  }
}

/**
 * Bounds every catalog wait in one request by one shared budget. Only time while some
 * wait is pending draws from it, so slow preparation between waits cannot fail a
 * published catalog and concurrent waits cannot stretch it. The shared catalog
 * publication keeps running after a timeout.
 */
export function createModelCatalogWait(params: {
  signal?: AbortSignal;
  connectionSignal?: AbortSignal;
  assertCurrent: () => void;
}): <T>(catalog: Promise<T>) => Promise<T> {
  let remainingMs = MODEL_CATALOG_WAIT_MS;
  let connectionSignal = params.connectionSignal;
  let deadline = new AbortController();
  let pendingWaits = 0;
  let pendingSince = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return async (catalog) => {
    if (pendingWaits++ === 0) {
      // A fresh deadline lets a published catalog win even after the budget is spent.
      const periodDeadline = new AbortController();
      deadline = periodDeadline;
      pendingSince = performance.now();
      timer = setTimeout(() => periodDeadline.abort(), Math.max(remainingMs, 0));
    }
    const waitSignal = params.signal
      ? AbortSignal.any([deadline.signal, params.signal])
      : deadline.signal;
    try {
      for (;;) {
        try {
          return await racePromiseWithAbortSignal(
            catalog,
            connectionSignal ? AbortSignal.any([waitSignal, connectionSignal]) : waitSignal,
          );
        } catch (error) {
          if (!waitSignal.aborted && !connectionSignal?.aborted) {
            throw error;
          }
          // Disconnect ends only requests whose authority belonged to that connection.
          params.assertCurrent();
          if (waitSignal.aborted) {
            throw new ModelCatalogLoadingError();
          }
          connectionSignal = undefined;
        }
      }
    } finally {
      if (--pendingWaits === 0) {
        clearTimeout(timer);
        remainingMs -= performance.now() - pendingSince;
      }
    }
  };
}
