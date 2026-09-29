import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";

const SESSION_CREATE_MODEL_CATALOG_WAIT_MS = 30_000;

export class SessionCreateModelCatalogUnavailableError extends Error {
  constructor() {
    super("Models are still loading; retry in a moment.");
    this.name = "SessionCreateModelCatalogUnavailableError";
  }
}

/** Bounds one creation's catalog wait; the shared catalog publication keeps running. */
export async function waitForSessionCreateModelCatalog<T>(
  catalog: Promise<T>,
  params: { signal?: AbortSignal; connectionSignal?: AbortSignal; commitGuard: () => void },
): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), SESSION_CREATE_MODEL_CATALOG_WAIT_MS);
  const waitSignal = params.signal
    ? AbortSignal.any([deadline.signal, params.signal])
    : deadline.signal;
  let connectionSignal = params.connectionSignal;
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
        // Disconnect ends only creations whose commit authority belonged to that connection.
        params.commitGuard();
        if (waitSignal.aborted) {
          throw new SessionCreateModelCatalogUnavailableError();
        }
        connectionSignal = undefined;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
