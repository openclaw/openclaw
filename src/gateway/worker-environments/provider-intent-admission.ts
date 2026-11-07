import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import type {
  WorkerProviderPreparedIntent,
  WorkerInitialSnapshotCustody,
} from "./preparation-identity.js";
import type { WorkerProviderRepositorySource } from "./provider-project-preparation.js";
import type { WorkerEnvironmentRecord } from "./store.js";

/** Request-scoped facts for the existing prepared intent; never replayed from durable state. */
export function createWorkerProviderIntentAdmission(options: { isStopping: () => boolean }) {
  const preparedIntents = new WeakMap<
    WorkerProviderPreparedIntent,
    {
      profileId: string;
      assertCurrent: () => void;
      repository?: WorkerProviderRepositorySource;
      initialSnapshot?: WorkerInitialSnapshotCustody;
    }
  >();
  const assertPreparedIntentCurrent = (profileId: string, intent: WorkerProviderPreparedIntent) => {
    const prepared = preparedIntents.get(intent);
    if (!prepared || prepared.profileId !== profileId) {
      throw serviceError("invalid_state", "Worker preparation is not owned by this lifecycle");
    }
    prepared.assertCurrent();
  };
  const requireProfileId = (profileId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (options.isStopping()) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    const normalizedProfileId = profileId.trim();
    if (!normalizedProfileId || normalizedProfileId !== profileId) {
      throw serviceError("invalid_profile", "Worker profile id must be non-empty and trimmed");
    }
    return normalizedProfileId;
  };
  return {
    preparedIntents,
    assertPreparedIntentCurrent,
    requireProfileId,
    takeInitialSnapshot(
      this: void,
      intent: WorkerProviderPreparedIntent,
      record: WorkerEnvironmentRecord,
    ) {
      assertPreparedIntentCurrent(record.profileId, intent);
      const prepared = preparedIntents.get(intent)!;
      const custody = prepared.initialSnapshot;
      delete prepared.initialSnapshot;
      return custody?.environmentId === record.environmentId &&
        custody.provisionOperationId === record.provisionOperationId &&
        custody.nodeDeviceId === record.nodeDeviceId &&
        custody.isNodeCurrent()
        ? custody
        : undefined;
    },
    preparedRepositorySource(this: void, profileId: string, intent: WorkerProviderPreparedIntent) {
      assertPreparedIntentCurrent(profileId, intent);
      return preparedIntents.get(intent)?.repository;
    },
  };
}
