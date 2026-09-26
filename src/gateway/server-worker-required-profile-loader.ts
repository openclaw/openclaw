import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import type { createRequiredWorkerSessionPreparation } from "./server-worker-required-profile.js";
import type { WorkerPlacementDispatchContract } from "./worker-environments/service-contract.js";

const loadRequiredWorkerSessionPreparation = createLazyRuntimeModule(
  () => import("./server-worker-required-profile.js"),
);
type PreparationOptions = Omit<
  Parameters<typeof createRequiredWorkerSessionPreparation>[0],
  "onTransition"
> & {
  getSessionChangeContext?: () => Parameters<typeof emitSessionsChanged>[0] | undefined;
};

/** Keep mandatory preparation lazy and bind its publications to the creating Gateway. */
export function createLazyRequiredWorkerSessionPreparer(
  options: PreparationOptions,
): NonNullable<WorkerPlacementDispatchContract["prepareRequiredSession"]> {
  return async (...args) => {
    if (!options.getConfig().cloudWorkers?.requiredProfile) {
      return;
    }
    const { createRequiredWorkerSessionPreparation } = await loadRequiredWorkerSessionPreparation();
    await createRequiredWorkerSessionPreparation({
      ...options,
      onTransition: (placement) => {
        const context = options.getSessionChangeContext?.();
        if (context) {
          emitSessionsChanged(context, {
            reason: "dispatch",
            sessionKey: placement.sessionKey,
            agentId: placement.agentId,
          });
        }
      },
    })(...args);
  };
}
