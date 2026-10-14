import type { SubsystemLogger } from "../logging/subsystem.js";
import { runWithRetainedGatewayRootWork } from "../process/gateway-work-admission.js";

export function dispatchEventHandler<TEvent>(params: {
  loadHandler: () => Promise<(event: TEvent) => unknown>;
  event: TEvent;
  log: SubsystemLogger;
  failureMessage: string;
  context: Record<string, unknown>;
  isDeliveryCurrent?: () => boolean;
  onFailure?: (error: unknown) => void;
}) {
  return runWithRetainedGatewayRootWork(() =>
    params
      .loadHandler()
      .then((handler) =>
        params.isDeliveryCurrent?.() === false ? undefined : handler(params.event),
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        params.log.warn(params.failureMessage, { ...params.context, error });
        params.onFailure?.(error);
      }),
  );
}
