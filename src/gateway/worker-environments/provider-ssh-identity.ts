import type { SecretRef } from "../../config/types.secrets.js";
import type { WorkerProvider } from "../../plugins/types.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { requireWorkerProfile } from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export function createWorkerSshIdentityResolver(
  options: Pick<
    WorkerProviderLifecycleOptions,
    "resolveSshIdentity" | "isStopping" | "callProvider"
  >,
  requireCurrentOwner: (record: WorkerEnvironmentRecord) => WorkerEnvironmentRecord,
) {
  const { callProvider } = options;
  return (record: WorkerEnvironmentRecord, provider: WorkerProvider, leaseId: string) => {
    const profile = requireWorkerProfile(record.profileSnapshot.settings);
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
        const current = requireCurrentOwner(record);
        if (options.isStopping() || current.destroyRequestedAtMs !== null) {
          throw new Error("Worker identity owner is closed");
        }
      };
      try {
        return await callProvider(record.environmentId, async () => {
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
