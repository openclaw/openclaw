import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { captureSessionEntrySourceAssertion } from "../../config/sessions/session-entry-source-authority.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import { assertRepositoryWorkspaceDiskIdentity } from "../../state/session-repository-workspaces.authority.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { isExactAttachedEnvironment, matchesWorkerPlacementTarget } from "./placement-target.js";
import { isWorkerRetainedWindowOpen } from "./retained-work-window.js";
import type { ActiveWorkerPlacement } from "./worker-turn-failure.js";
import type { WorkerTurnLauncherOptions } from "./worker-turn-launcher.types.js";

/** Explicit input may wake its original disk; pending results and maintenance never do. */
export async function prepareRetainedWorkerTurn(params: {
  options: WorkerTurnLauncherOptions;
  placement: ActiveWorkerPlacement;
  turn: SessionPlacementTurnParams;
  assertCurrent: () => void;
}) {
  const { options, placement, turn } = params;
  const { placements, environments } = options;
  const environment = environments.get(placement.environmentId);
  params.assertCurrent();
  const workspace = await options.resolveWorkspace(placement);
  params.assertCurrent();
  if (workspace.kind !== "repository" || !workspace.repository.diskAuthority) {
    return undefined;
  }
  const authority = workspace.repository.diskAuthority;
  const repository = workspace.repository;
  const preparedRepository = await getSessionRepositoryWorkspaceStore().prepare(
    repository.workspaceId,
  );
  const source = await captureSessionEntrySourceAssertion({
    scope: {
      agentId: placement.agentId,
      sessionKey: placement.sessionKey,
      storePath: turn.sessionTarget?.storePath ?? resolveSessionStorePathForScope(placement),
    },
    expected: {
      sessionId: placement.sessionId,
      repositoryWorkspaceId: repository.workspaceId,
      archivedAt: undefined,
    },
    fields: ["sessionId", "repositoryWorkspaceId", "archivedAt"],
    assertCurrent: params.assertCurrent,
    assertHostCurrent: params.assertCurrent,
    refuse: () => {
      throw new Error("Repository session changed while waking its retained worker");
    },
  }).prepareSessionSource();
  const release = async () => {
    await source.release?.();
  };
  try {
    const assertCurrent = () => {
      params.assertCurrent();
      source.assertCurrent();
      const currentRepository = preparedRepository.current();
      const current = placements.get(placement.sessionId);
      const currentEnvironment = environments.get(placement.environmentId);
      assertRepositoryWorkspaceDiskIdentity(authority, currentEnvironment);
      if (
        currentRepository?.revision !== repository.revision ||
        repository.agentId !== placement.agentId ||
        repository.sessionKey !== placement.sessionKey ||
        current?.state !== "active" ||
        !matchesWorkerPlacementTarget(current, placement) ||
        current.agentId !== placement.agentId ||
        current.sessionKey !== placement.sessionKey ||
        current.executionMode !== placement.executionMode ||
        current.remoteWorkspaceDir !== placement.remoteWorkspaceDir ||
        current.turnClaim ||
        !isExactAttachedEnvironment(currentEnvironment, current) ||
        !currentEnvironment?.nodeDeviceId ||
        currentEnvironment.nodeDeviceId !== environment?.nodeDeviceId
      ) {
        throw new Error("Repository disk changed while waking its retained worker");
      }
    };
    const assertIdle = async () => {
      const facts = await placements.prepareRuntimeRefresh(placement.sessionId);
      try {
        assertCurrent();
        facts.assertCurrent();
        if (facts.pendingResult || facts.move) {
          throw new Error("Repository disk has pending work before turn admission");
        }
      } finally {
        facts.release();
      }
    };
    await assertIdle();
    await environments.ensureRetainedRunning({
      environmentId: placement.environmentId,
      expectedOwnerEpoch: placement.activeOwnerEpoch,
      assertCurrent,
      signal: turn.abortSignal,
    });
    // Runtime refresh may change the bundle, never the original placement or input.
    await assertIdle();
    if (!isWorkerRetainedWindowOpen(environments.get(placement.environmentId))) {
      throw new Error("Retained worker runtime is not ready for turn admission");
    }
    const current = placements.get(placement.sessionId);
    if (current?.state !== "active") {
      throw new Error("Repository disk placement changed before turn admission");
    }
    return { placement: current, assertCurrent, release };
  } catch (error) {
    await release();
    throw error;
  }
}
