import { recordWorkerPlacementAwait } from "./placement-diagnostics.js";
import type { WorkerPlacementDispatchOptions } from "./placement-dispatch.types.js";
import { isFailedWorkerPlacementEnvironmentGone } from "./placement-target.js";
import type { createRetainedWorkerRecovery } from "./retained-worker-recovery.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";
import { prepareRepositoryRefWorkerPlacement } from "./session-placement-lifecycle.js";

/** Join old-worker custody before the local dispatch barrier can allocate its replacement. */
export async function prepareDispatchWorkerRecovery(
  options: WorkerPlacementDispatchOptions,
  retainedRecovery: ReturnType<typeof createRetainedWorkerRecovery>,
  request: WorkerPlacementDispatchRequest,
  assertCurrent: () => void,
  signal?: AbortSignal,
) {
  const { placements, environments } = options;
  const preparedLostWorker = await recordWorkerPlacementAwait(
    request.sessionId,
    "repository_ref_preparation",
    () => prepareRepositoryRefWorkerPlacement(options, request, assertCurrent, signal),
    {},
    "dispatch",
  );
  const failed = placements.get(request.sessionId);
  if (
    !preparedLostWorker &&
    failed?.state === "failed" &&
    !isFailedWorkerPlacementEnvironmentGone({
      environmentService: environments,
      placement: failed,
    })
  ) {
    await recordWorkerPlacementAwait(
      request.sessionId,
      "retained_worker_recovery",
      () =>
        retainedRecovery.recover(failed, {
          assertCurrent,
          signal,
          operatorAuthority: request.operatorAuthority,
          readNativeCredential: request.readNativeCredential,
        }),
      { generation: failed.generation, environmentId: failed.environmentId ?? undefined },
      "dispatch",
    );
    assertCurrent();
  }
}
