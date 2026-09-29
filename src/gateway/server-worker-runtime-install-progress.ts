import { AsyncLocalStorage } from "node:async_hooks";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { markDiagnosticRunProgress } from "../logging/diagnostic-run-activity.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import type { GatewayNodeWorkerBundleInstallObservation } from "./worker-environments/node-worker-bundle-installer.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerEnvironmentStore } from "./worker-environments/store.js";

export function createWorkerRuntimeInstallProgressPublisher(params: {
  environments: Pick<WorkerEnvironmentStore, "listForReconcile" | "get">;
  placements: Pick<WorkerSessionPlacementStore, "readProjection">;
  readInstall: (
    nodeId: string,
  ) => Pick<GatewayNodeWorkerBundleInstallObservation, "bundleHash" | "environmentIds"> | undefined;
  warn: (message: string) => void;
}) {
  // Transfer callbacks can inherit a caller's temporary read admission.
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const pendingNodes = new Set<string>();
  // Notifications name their environments: a completed install no longer lists them.
  const pendingEnvironments = new Set<string>();
  let publication: Promise<void> | undefined;
  let stopped = false;
  const publishPending = () => {
    if (publication || stopped) {
      return;
    }
    publication = Promise.resolve()
      .then(async () => {
        while (pendingNodes.size > 0) {
          if (stopped) {
            return;
          }
          const nodeIds = new Set(pendingNodes);
          const notifiedEnvironments = new Set(pendingEnvironments);
          pendingNodes.clear();
          pendingEnvironments.clear();
          try {
            const sessionIds = uniqueStrings(
              params.environments
                .listForReconcile()
                .flatMap((environment) =>
                  (environment.nodeDeviceId && nodeIds.has(environment.nodeDeviceId)) ||
                  notifiedEnvironments.has(environment.environmentId)
                    ? environment.attachedSessionIds
                    : [],
                ),
            );
            if (sessionIds.length === 0) {
              continue;
            }
            const { placements } = await inOwnerContext(() =>
              params.placements.readProjection(sessionIds, { current: true }),
            );
            if (stopped) {
              return;
            }
            const observations = new Map(
              [...nodeIds].map((nodeId) => [nodeId, params.readInstall(nodeId)]),
            );
            for (const placement of placements.values()) {
              const environment = placement.environmentId
                ? params.environments.get(placement.environmentId)
                : undefined;
              if (
                !environment ||
                environment.state === "destroyed" ||
                environment.state === "failed" ||
                environment.state === "orphaned" ||
                !environment.attachedSessionIds.includes(placement.sessionId)
              ) {
                continue;
              }
              const observation =
                (environment.nodeDeviceId
                  ? observations.get(environment.nodeDeviceId)
                  : undefined) ??
                [...observations.values()].find((candidate) =>
                  candidate?.environmentIds.includes(environment.environmentId),
                );
              if (
                !(environment.nodeDeviceId && nodeIds.has(environment.nodeDeviceId)) &&
                !notifiedEnvironments.has(environment.environmentId)
              ) {
                continue;
              }
              if (
                observation &&
                ((placement.state === "provisioning" &&
                  observation.environmentIds.includes(environment.environmentId)) ||
                  (placement.state === "active" &&
                    placement.workerBundleHash !== observation.bundleHash &&
                    !placement.turnClaim))
              ) {
                markDiagnosticRunProgress({
                  sessionId: placement.sessionId,
                  sessionKey: placement.sessionKey,
                  reason: "worker:runtime_install",
                  onlyIfActive: true,
                });
              }
              emitSessionLifecycleEvent({
                sessionKey: placement.sessionKey,
                agentId: placement.agentId,
                reason: "worker-runtime-install",
                scope: "runtime",
              });
            }
          } catch (error) {
            params.warn(`Worker runtime install progress publication failed: ${String(error)}`);
          }
        }
      })
      .finally(() => {
        publication = undefined;
        if (pendingNodes.size > 0) {
          publishPending();
        }
      });
  };
  return {
    changed: (nodeId: string, environmentIds: readonly string[]) => {
      if (!stopped) {
        pendingNodes.add(nodeId);
        for (const environmentId of environmentIds) {
          pendingEnvironments.add(environmentId);
        }
        publishPending();
      }
    },
    stop: async () => {
      stopped = true;
      pendingNodes.clear();
      pendingEnvironments.clear();
      await publication;
    },
  };
}
