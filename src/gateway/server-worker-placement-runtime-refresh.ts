import { compareOpenClawReleaseVersions } from "../infra/npm-registry-spec.js";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import type { waitForNodeWorkerSupervisor } from "./node-registry-private.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./worker-environments/device-provider-identity.js";
import { readWorkerPreparation } from "./worker-environments/preparation-identity.schema.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";
import type { createWorkerSessionTurnPlacementProvider } from "./worker-environments/worker-turn-launcher.js";

type NodeAvailabilityWait = (
  nodeId: string,
  options: Parameters<typeof waitForNodeWorkerSupervisor>[2],
) => Promise<void>;

/** Bind pre-handoff admission to this Gateway's node registry and lifetime. */
export function createWorkerRuntimeRefreshWaiter(params: {
  environments: WorkerEnvironmentService;
  isStopping: () => boolean;
  hasCurrentRunner: (deviceId: string) => boolean;
}) {
  let waitForNode: NodeAvailabilityWait | undefined;
  let nodeVersion: ((nodeId: string) => string | undefined) | undefined;
  let nodeBuildId: ((nodeId: string) => string | undefined) | undefined;
  const wait: Parameters<
    typeof createWorkerSessionTurnPlacementProvider
  >[0]["waitForAdmissionNode"] = async ({ placement, signal, assertCurrent }) => {
    const environment = params.environments.get(placement.environmentId);
    if (!environment?.nodeDeviceId) {
      return;
    }
    if (!waitForNode) {
      throw new Error("Worker node availability runtime is unavailable");
    }
    const waitingSignal = AbortSignal.any([signal, getGatewayRestartDrainSignal()]);
    const assertWaitingCurrent = () => {
      waitingSignal.throwIfAborted();
      assertCurrent();
      const current = params.environments.get(placement.environmentId);
      if (
        params.isStopping() ||
        params.environments.isStopping() ||
        current?.state !== "attached" ||
        current.ownerEpoch !== placement.activeOwnerEpoch ||
        current.nodeDeviceId !== environment.nodeDeviceId ||
        current.leaseId !== environment.leaseId ||
        current.destroyRequestedAtMs !== null ||
        current.attachedSessionIds.length !== 1 ||
        current.attachedSessionIds[0] !== placement.sessionId
      ) {
        throw new Error("Worker admission lost its environment while waiting for reconnect");
      }
    };
    assertWaitingCurrent();
    const deviceId = environment.nodeDeviceId;
    const version = nodeVersion?.(deviceId);
    const currentBuildId = resolveRuntimeServiceBuildId();
    const comparison = version ? compareOpenClawReleaseVersions(version, VERSION) : undefined;
    const staleBuild = Boolean(
      currentBuildId && comparison === 0 && nodeBuildId?.(deviceId) !== currentBuildId,
    );
    const managedLinux =
      environment.providerId !== DEVICE_WORKER_PROVIDER_ID &&
      environment.sharedHost === false &&
      readWorkerPreparation(environment.profileSnapshot)?.target.platform === "linux";
    const connected = params.hasCurrentRunner(deviceId);
    const obsolete = managedLinux && version !== undefined && ((comparison ?? 0) < 0 || staleBuild);
    // Recovery must keep using the current package after an upgrade, rather than
    // returning to the creation-time archive still recorded in the profile.
    const upgradeRuntime = managedLinux && (!connected || obsolete);
    let cleanupOnly = false;
    if (!connected || obsolete) {
      const resumed = await params.environments.resumeNode(environment.environmentId, {
        ...(upgradeRuntime ? { upgradeRuntime: true } : {}),
        signal: waitingSignal,
        assertCurrent: assertWaitingCurrent,
      });
      cleanupOnly = resumed?.retainedCleanupOnly === true;
      assertWaitingCurrent();
    }
    await waitForNode(deviceId, {
      signal: waitingSignal,
      assertCurrent: assertWaitingCurrent,
      ...(upgradeRuntime && nodeVersion && !cleanupOnly
        ? {
            isReady: () => {
              const current = nodeVersion?.(deviceId);
              return (
                current !== undefined &&
                (compareOpenClawReleaseVersions(current, VERSION) ?? -1) >= 0 &&
                (!currentBuildId || nodeBuildId?.(deviceId) === currentBuildId)
              );
            },
          }
        : {}),
    });
    assertWaitingCurrent();
  };
  return {
    wait,
    bind: (
      bound: NodeAvailabilityWait,
      version?: (nodeId: string) => string | undefined,
      buildId?: (nodeId: string) => string | undefined,
    ) => {
      waitForNode = bound;
      nodeVersion = version;
      nodeBuildId = buildId;
    },
  };
}
