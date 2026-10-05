import { readImageReserveProject } from "./image-reserve.js";
import type {
  PreparedCandidateRejectionCode,
  PreparedCandidateRejectionObserver,
} from "./placement-diagnostics.js";
import {
  isWorkerImagePreparationCompatible,
  type WorkerProviderPreparedIntent,
} from "./preparation-identity.js";
import type { createPreparedPoolPresence } from "./prepared-pool-presence.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";

/** Selection retains the pool owner's live policy, presence and clock reads. */
export function createPreparedWorkerCandidateSelection(options: {
  store: WorkerEnvironmentStore;
  policy: (record: WorkerEnvironmentRecord) => { target: number; maxTotal: number };
  presence: Pick<ReturnType<typeof createPreparedPoolPresence>, "current" | "matchesCurrentPolicy">;
  poolProject: (record: WorkerEnvironmentRecord) => { key: string } | null | undefined;
  now: () => number;
}) {
  const { store, policy, presence, poolProject, now } = options;
  return (
    intent: WorkerProviderPreparedIntent,
    profileId?: string,
    observeRejection?: PreparedCandidateRejectionObserver,
  ) =>
    intent.preparationKey
      ? store.list().filter((record) => {
          const limits = policy(record);
          const presenceDemand = presence.current();
          const imageReserve = readImageReserveProject(record.profileSnapshot.project);
          const selectedByImage =
            process.env.FACTORY_AUTH_MODE === "github" &&
            imageReserve &&
            "source" in (readWorkerProjectSnapshot(intent.profileSnapshot.project) ?? {}) &&
            presenceDemand?.project.key === imageReserve.key &&
            presenceDemand.preparationKey === record.preparation?.key &&
            (presenceDemand.retireAtMs ?? Number.MAX_SAFE_INTEGER) > now() &&
            presence.matchesCurrentPolicy(presenceDemand) &&
            record.profileId === profileId &&
            isWorkerImagePreparationCompatible(record.profileSnapshot, intent.profileSnapshot);
          let rejection: PreparedCandidateRejectionCode | undefined;
          if (!(limits.target > 0)) {
            rejection = "target_disabled";
          } else if (!(limits.maxTotal > 0)) {
            rejection = "pool_disabled";
          } else if (record.state !== "ready") {
            rejection = "not_ready";
          } else if (record.providerId !== intent.providerId) {
            rejection = "provider_mismatch";
          } else if (record.preparation === null) {
            rejection = "preparation_missing";
          } else if (!(record.preparation.key === intent.preparationKey || selectedByImage)) {
            rejection = "preparation_mismatch";
          } else if (record.preparation.consumedAtMs !== null) {
            rejection = "consumed";
          } else if (
            !(
              (presenceDemand?.project.key === poolProject(record)?.key &&
                (presenceDemand!.retireAtMs ?? Number.MAX_SAFE_INTEGER) > now()) ||
              record.preparation.expiresAtMs > now()
            )
          ) {
            rejection = "expired";
          } else if (record.destroyRequestedAtMs !== null) {
            rejection = "destroy_requested";
          } else if (record.sharedHost !== false) {
            rejection = "not_dedicated";
          } else if (record.nodeDeviceId === null) {
            rejection = "node_missing";
          } else if (record.leaseId === null) {
            rejection = "lease_missing";
          }
          if (
            rejection &&
            observeRejection &&
            record.profileId === profileId &&
            record.preparation?.consumedAtMs === null &&
            !["failed", "destroyed"].includes(record.state)
          ) {
            try {
              observeRejection(record.environmentId, rejection);
            } catch {
              // An optional observer cannot turn an eligibility decision into a failure.
            }
          }
          if (rejection !== undefined) {
            return false;
          }
          // Display inventory can retain pending rows; selection requires the owner's live fence.
          return store.get(record.environmentId) !== undefined;
        })
      : [];
}
