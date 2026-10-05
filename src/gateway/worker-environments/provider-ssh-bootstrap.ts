import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { createWorkerProviderOwnerLifecycle } from "./provider-owner-lifecycle.js";
import type { createWorkerProvisionCancellation } from "./provider-provisioning-cancellation.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export function createWorkerSshBootstrap(
  options: Pick<
    WorkerProviderLifecycleOptions,
    "callBootstrap" | "bootstrapWorker" | "credentialBroker"
  > &
    Pick<
      ReturnType<typeof createWorkerProviderOwnerLifecycle>,
      "identityResolverFor" | "requireCurrentOwner" | "failBootstrap"
    >,
) {
  const { callBootstrap, identityResolverFor, requireCurrentOwner, failBootstrap } = options;
  const { commitReady } = options.credentialBroker;
  return async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    installation: WorkerInstallationArtifact,
    cancellation?: ReturnType<typeof createWorkerProvisionCancellation>,
  ) => {
    if (record.state !== "bootstrapping" || !record.leaseId || !record.sshEndpoint) {
      throw serviceError("invalid_state", "Worker bootstrap requires a provisioned SSH lease");
    }
    const leaseId = record.leaseId;
    const sshEndpoint = record.sshEndpoint;
    let receipt: WorkerAdmissionHandshake;
    try {
      receipt = await callBootstrap(installation, (signal) =>
        options.bootstrapWorker({
          operationId: record.provisionOperationId,
          sshEndpoint,
          installation,
          resolveIdentity: identityResolverFor(record, provider, leaseId),
          signal: cancellation ? AbortSignal.any([signal, cancellation.signal]) : signal,
        }),
      );
      cancellation?.assertActive();
      if (!sameWorkerBuild(receipt, installation)) {
        throw new Error("Worker bootstrap receipt does not match the expected build identity");
      }
    } catch (error) {
      await cancellation?.settleStopIntent();
      return await failBootstrap(record, leaseId, provider, error);
    }
    return commitReady(record, { ...receipt, installKind: "bundle" }, {}, () => {
      cancellation?.assertActive();
      const current = requireCurrentOwner(record);
      if (current.destroyRequestedAtMs !== null) {
        throw serviceError("invalid_state", "Worker bootstrap owner is stopping");
      }
    });
  };
}
