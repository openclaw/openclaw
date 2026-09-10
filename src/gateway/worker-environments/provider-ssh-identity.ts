import type { SecretRef } from "../../config/types.secrets.js";
import type { WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export function createWorkerSshIdentityResolver(options: {
  requireCurrentOwner: (record: WorkerEnvironmentRecord) => WorkerEnvironmentRecord;
  isStopping: () => boolean;
  callProvider: WorkerProviderLifecycleOptions["callProvider"];
  requireWorkerProfile: (value: unknown) => WorkerProfile;
  resolveSshIdentity?: WorkerProviderLifecycleOptions["resolveSshIdentity"];
}) {
  return (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    leaseId: string,
    authorize?: () => void,
  ) => {
    const profile = options.requireWorkerProfile(record.profileSnapshot.settings);
    return async (keyRef: SecretRef, context: { assertCurrent: () => void }) => {
      const resolveSshIdentity = options.resolveSshIdentity;
      if (!resolveSshIdentity) {
        throw new Error("Worker SSH identity resolution is unavailable");
      }
      let open = true;
      const assertAuthorized = () => {
        if (!open) {
          throw new Error("Worker SSH identity invocation is closed");
        }
        context.assertCurrent();
        const current = options.requireCurrentOwner(record);
        if (options.isStopping() || current.destroyRequestedAtMs !== null) {
          throw new Error("Worker identity owner is closed");
        }
        authorize?.();
      };
      try {
        // New provisioning owns capability admission. Restoring an accepted lease's
        // tunnel must preserve legacy identity lookup while retaining its live owner checks.
        return await options.callProvider(record.environmentId, async () => {
          assertAuthorized();
          const identity = await resolveSshIdentity({
            provider,
            leaseId,
            profile,
            keyRef,
            assertAuthorized,
          });
          assertAuthorized();
          return identity;
        });
      } finally {
        // A caller-visible timeout closes authority, not the underlying provider queue owner.
        open = false;
      }
    };
  };
}
