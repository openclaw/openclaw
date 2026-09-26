import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { captureGatewaySessionWorkAdmissions } from "../../sessions/session-lifecycle-admission.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import { isExactAttachedEnvironment } from "./placement-dispatch-failure.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";

type DevicePlacementDemandSources = {
  resolveGatewayContext: GatewayContextResolver;
  placements: Pick<WorkerSessionPlacementStore, "getMany">;
  environments: Pick<WorkerEnvironmentService, "get">;
};

/** Projects admitted session work without turning idle placements into slot reservations. */
export function createDevicePlacementDemandReader(sources: DevicePlacementDemandSources) {
  return (excludeSessionId?: string): ReadonlyMap<string, number> => {
    const params = { ...sources, excludeSessionId };
    const demand = new Map<string, number>();
    if (!params.resolveGatewayContext()) {
      return demand;
    }
    const admissions = captureGatewaySessionWorkAdmissions(params.resolveGatewayContext);
    const targets = new Set<string>();
    for (const identities of admissions.targets.values()) {
      for (const identity of identities) {
        targets.add(identity);
      }
    }
    if (targets.size === 0) {
      return demand;
    }
    const placements = params.placements.getMany([...targets]);
    const countedEnvironments = new Set<string>();
    for (const [scope, identities] of admissions.targets) {
      for (const identity of identities) {
        const placement = placements.get(identity);
        if (
          !placement ||
          placement.sessionId === params.excludeSessionId ||
          placement.state !== "active" ||
          placement.executionMode !== "worker-turn" ||
          countedEnvironments.has(placement.environmentId) ||
          !admissions.isActive({
            scope,
            sessionKey: placement.sessionKey,
            sessionId: placement.sessionId,
          })
        ) {
          continue;
        }
        const session = loadExactSessionEntryReadOnly({
          storePath: scope,
          sessionKey: placement.sessionKey,
          agentId: placement.agentId,
          projection: "list",
        });
        if (session?.entry.sessionId !== placement.sessionId) {
          continue;
        }
        const environment = params.environments.get(placement.environmentId);
        if (
          environment?.providerId !== DEVICE_WORKER_PROVIDER_ID ||
          !environment.nodeDeviceId ||
          !isExactAttachedEnvironment(environment, placement)
        ) {
          continue;
        }
        countedEnvironments.add(environment.environmentId);
        demand.set(environment.nodeDeviceId, (demand.get(environment.nodeDeviceId) ?? 0) + 1);
      }
    }
    return demand;
  };
}
