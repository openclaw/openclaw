import { isDeepStrictEqual } from "node:util";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { findSessionRepositoryWorkspaces } from "../../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import type { WorkerDevicePlacementRequirementResolver } from "./placement-dispatch-startup.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import { matchesWorkerPlacementTarget } from "./placement-target.js";
import { canRedispatchFailedWorkerPlacement } from "./session-placement-lifecycle.js";

type RedispatchableWorkerPlacement = Extract<
  WorkerSessionPlacementRecord,
  { state: "reclaimed" | "failed" }
>;

function repositoryDispatchTarget(workspace: SessionRepositoryWorkspaceRecord) {
  // Checkpoint/base progress belongs to the dispatch CAS owners, not credential selection.
  const {
    baseCommit: _baseCommit,
    baseManifestHash: _baseManifestHash,
    checkpointRef: _checkpointRef,
    manifestHash: _manifestHash,
    revision: _revision,
    updatedAtMs: _updatedAtMs,
    ...target
  } = workspace;
  return target;
}

export function createWorkerPlacementRedispatch(params: {
  placements: Pick<WorkerSessionPlacementStore, "readProjection" | "prepareRuntimeRefresh">;
  dispatch: WorkerPlacementDispatchService["dispatch"];
  resolveRepositoryWorkspace?: (identity: {
    agentId: string;
    sessionKey: string;
    sessionId: string;
  }) => Promise<SessionRepositoryWorkspaceRecord | undefined>;
  resolveDevicePlacementRequirement?: WorkerDevicePlacementRequirementResolver;
}) {
  return async (
    placement: RedispatchableWorkerPlacement,
    {
      assertCurrent,
      signal,
      operatorAuthority,
    }: {
      assertCurrent: () => void;
      signal?: AbortSignal;
      operatorAuthority?: AdmittedRunOperatorAuthority;
    },
  ) => {
    let retainedPlacement:
      | Awaited<ReturnType<WorkerSessionPlacementStore["prepareRuntimeRefresh"]>>
      | undefined;
    let settled = false;
    try {
      signal?.throwIfAborted();
      assertCurrent();
      if (process.env.FACTORY_AUTH_MODE === "github") {
        retainedPlacement = await params.placements.prepareRuntimeRefresh(placement.sessionId);
        signal?.throwIfAborted();
        assertCurrent();
        retainedPlacement.assertCurrent();
      }
      signal?.throwIfAborted();
      assertCurrent();
      const projection = await params.placements.readProjection([placement.sessionId], {
        current: true,
      });
      signal?.throwIfAborted();
      assertCurrent();
      retainedPlacement?.assertCurrent();
      const current = projection.placements.get(placement.sessionId);
      if (
        !matchesWorkerPlacementTarget(current, placement) ||
        current?.agentId !== placement.agentId ||
        current.sessionKey !== placement.sessionKey
      ) {
        throw new Error("Worker placement changed before automatic recovery");
      }
      const previousEnvironment = placement.environmentId
        ? projection.environments.get(placement.environmentId)
        : undefined;
      if (!previousEnvironment) {
        throw new Error(
          `Worker placement has no environment record: ${placement.environmentId}. Choose where the session should continue.`,
        );
      }
      if (
        placement.state === "failed" &&
        !canRedispatchFailedWorkerPlacement(placement, previousEnvironment)
      ) {
        throw new Error(`Worker recovery is not ready: ${placement.recoveryError}`);
      }
      const { profileId, providerId, profileSnapshot, nodeDeviceId } = previousEnvironment;
      const { sessionId, sessionKey, agentId, executionMode } = placement;
      const identity = { sessionId, sessionKey, agentId, executionMode };
      let readNativeCredential:
        | ((env: NodeJS.ProcessEnv) => Promise<string | undefined>)
        | undefined;
      let dispatchTarget: WorkerSessionPlacementRecord = placement;
      if (process.env.FACTORY_AUTH_MODE === "github") {
        const resolveRepositoryWorkspace =
          params.resolveRepositoryWorkspace ??
          (async (target) =>
            (
              await findSessionRepositoryWorkspaces([target], {
                path: resolveOpenClawStateSqlitePath(),
              })
            )[0]);
        const workspace = await resolveRepositoryWorkspace(identity);
        signal?.throwIfAborted();
        assertCurrent();
        retainedPlacement?.assertCurrent();
        if (workspace) {
          if (!operatorAuthority?.createFactoryGitHubDispatchCredentialReader) {
            throw new Error(
              "Factory repository redispatch requires the original live credential authority",
            );
          }
          assertAdmittedRunOperatorAuthority(operatorAuthority);
          const assertSourceCurrent = () => {
            signal?.throwIfAborted();
            assertCurrent();
            operatorAuthority.assertCurrent();
            if (settled) {
              throw new Error("Factory repository redispatch has already settled");
            }
          };
          const assertDispatchCurrent = () => {
            assertSourceCurrent();
            retainedPlacement?.assertCurrent();
            const currentPlacement = retainedPlacement?.placement;
            if (
              !retainedPlacement ||
              !matchesWorkerPlacementTarget(currentPlacement, dispatchTarget) ||
              currentPlacement?.agentId !== agentId ||
              currentPlacement.sessionKey !== sessionKey ||
              currentPlacement.executionMode !== executionMode
            ) {
              throw new Error("Factory repository redispatch owner changed");
            }
          };
          const repositoryTarget = repositoryDispatchTarget(workspace);
          const assertWorkspaceCurrent = async () => {
            assertSourceCurrent();
            // Only our acknowledged transition callback may advance the retained source.
            if (retainedPlacement) {
              assertDispatchCurrent();
            }
            const expected = dispatchTarget;
            const prepared = await params.placements.prepareRuntimeRefresh(sessionId);
            try {
              assertSourceCurrent();
              retainedPlacement?.assertCurrent();
              prepared.assertCurrent();
              const preparedPlacement = prepared.placement;
              if (
                expected !== dispatchTarget ||
                !matchesWorkerPlacementTarget(preparedPlacement, expected) ||
                preparedPlacement?.agentId !== agentId ||
                preparedPlacement.sessionKey !== sessionKey ||
                preparedPlacement.executionMode !== executionMode
              ) {
                throw new Error("Factory repository redispatch owner changed during preparation");
              }
            } catch (error) {
              prepared.release();
              throw error;
            }
            retainedPlacement?.release();
            retainedPlacement = prepared;
            const currentWorkspace = await resolveRepositoryWorkspace(identity);
            assertDispatchCurrent();
            if (
              !currentWorkspace ||
              !isDeepStrictEqual(repositoryDispatchTarget(currentWorkspace), repositoryTarget)
            ) {
              throw new Error("Factory repository redispatch workspace changed");
            }
          };
          await assertWorkspaceCurrent();
          const reader = operatorAuthority.createFactoryGitHubDispatchCredentialReader({
            agentId,
            sessionKey,
            sessionId,
            repositoryUrl: workspace.url,
            assertCurrent: assertDispatchCurrent,
          });
          if (!reader) {
            throw new Error("Factory repository redispatch credential authority is unavailable");
          }
          readNativeCredential = async (env) => {
            await assertWorkspaceCurrent();
            const token = await reader(env);
            await assertWorkspaceCurrent();
            return token;
          };
        }
      }
      let devicePlacement:
        | Awaited<ReturnType<WorkerDevicePlacementRequirementResolver>>
        | undefined;
      if (nodeDeviceId) {
        if (!params.resolveDevicePlacementRequirement) {
          throw new Error("Node-backed redispatch has no authoritative runtime requirement");
        }
        devicePlacement = await params.resolveDevicePlacementRequirement(identity);
      }
      signal?.throwIfAborted();
      assertCurrent();
      retainedPlacement?.assertCurrent();
      return await params.dispatch(
        {
          ...identity,
          ...(operatorAuthority ? { operatorAuthority } : {}),
          ...(readNativeCredential ? { readNativeCredential } : {}),
          profileId,
          expectedPlacement: {
            state: placement.state,
            generation: placement.generation,
            environmentId: placement.environmentId,
            activeOwnerEpoch: placement.activeOwnerEpoch,
          },
          ...(devicePlacement ? { devicePlacement } : {}),
          ...(providerId === DEVICE_WORKER_PROVIDER_ID && nodeDeviceId
            ? { deviceId: nodeDeviceId }
            : {}),
          inheritedProfile: { providerId, profileSnapshot },
        },
        readNativeCredential
          ? (observed) => {
              if (
                observed.sessionId !== sessionId ||
                observed.sessionKey !== sessionKey ||
                observed.agentId !== agentId ||
                observed.executionMode !== executionMode
              ) {
                throw new Error("Factory repository redispatch observed another session owner");
              }
              retainedPlacement?.release();
              retainedPlacement = undefined;
              dispatchTarget = observed;
            }
          : undefined,
        assertCurrent,
        signal,
      );
    } finally {
      settled = true;
      retainedPlacement?.release();
    }
  };
}
