import type { WorkerPlacementAuthorization } from "../worker-environments/placement-authorization.js";
import type { SessionMutationAuthorization } from "./types.js";

export async function withWorkerPlacementAuthorization<T>(
  authorization: SessionMutationAuthorization | undefined,
  operation: (authorize: WorkerPlacementAuthorization | undefined) => Promise<T>,
): Promise<T> {
  const assertCurrent = authorization?.assertCurrent;
  const prepared = await authorization?.prepareWorkerGrant?.();
  try {
    return await operation(
      prepared
        ? Object.assign(() => prepared.assertCurrent(), {
            assertWorkerGrant: prepared.assertCurrent,
            assertWorkerLifetime: prepared.assertLifetimeCurrent,
          })
        : assertCurrent,
    );
  } finally {
    await prepared?.release();
  }
}
