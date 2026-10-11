import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import { captureGatewaySessionWorkAdmissions } from "../../sessions/session-lifecycle-admission.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import { isExactAttachedEnvironment } from "./placement-target.js";
import type { WorkerEnvironmentService } from "./service.js";

type DevicePlacementDemandSources = {
  resolveGatewayContext: GatewayContextResolver;
  environments: Pick<WorkerEnvironmentService, "get">;
};

function captureDemand(sources: DevicePlacementDemandSources) {
  const gatewayContext = sources.resolveGatewayContext();
  const admissions = captureGatewaySessionWorkAdmissions(sources.resolveGatewayContext);
  const targets = new Set<string>();
  if (gatewayContext) {
    for (const identities of admissions.targets.values()) {
      for (const identity of identities) {
        targets.add(identity);
      }
    }
  }
  return { admissions, targets: [...targets], gatewayContext };
}

function projectDemand(
  sources: DevicePlacementDemandSources,
  admissions: ReturnType<typeof captureGatewaySessionWorkAdmissions>,
  placements: ReadonlyMap<string, WorkerSessionPlacementRecord>,
  excludeSessionId?: string,
): ReadonlyMap<string, number> {
  const demand = new Map<string, number>();
  const countedEnvironments = new Set<string>();
  for (const [scope, identities] of admissions.targets) {
    for (const identity of identities) {
      const placement = placements.get(identity);
      if (
        !placement ||
        placement.sessionId === excludeSessionId ||
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
      const target = {
        storePath: scope,
        sessionKey: placement.sessionKey,
        agentId: placement.agentId,
      };
      const metadata = captureSessionEntryMetadataRead(target);
      const entry = metadata
        ? metadata.readCurrent()
        : loadExactSessionEntryReadOnly({
            ...target,
            projection: "list",
          })?.entry;
      if (entry?.sessionId !== placement.sessionId) {
        continue;
      }
      const environment = sources.environments.get(placement.environmentId);
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
}

/** Projects admitted session work without turning idle placements into slot reservations. */
export function createDevicePlacementDemandReader(
  sources: DevicePlacementDemandSources & {
    placements: Pick<WorkerSessionPlacementStore, "getMany">;
  },
) {
  return (excludeSessionId?: string): ReadonlyMap<string, number> => {
    const { admissions, targets } = captureDemand(sources);
    return targets.length
      ? projectDemand(sources, admissions, sources.placements.getMany(targets), excludeSessionId)
      : new Map();
  };
}

export function createDevicePlacementDemandReaderAsync(
  sources: DevicePlacementDemandSources & {
    placements: Pick<WorkerSessionPlacementStore, "getManyAsync">;
  },
) {
  return async (excludeSessionId?: string): Promise<ReadonlyMap<string, number>> => {
    const { admissions, targets, gatewayContext } = captureDemand(sources);
    if (!targets.length) {
      return new Map();
    }
    const placements = await sources.placements.getManyAsync(targets);
    return sources.resolveGatewayContext() === gatewayContext
      ? projectDemand(sources, admissions, placements, excludeSessionId)
      : new Map();
  };
}
