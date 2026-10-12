import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createGitHubPublicationWorkerScope } from "../state/github-publication-worker.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { requirePersonalGitHubPublicationConfirmationAsync } from "./github-publication-store-async.js";
import { reportGitHubPublicationTranscript } from "./github-publication-transcript.js";
import { createGitHubPublicationCoordinator } from "./github-publication.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

export function createGitHubPublicationRuntime(params: {
  placements: WorkerSessionPlacementStore;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  loadSessionRuntime: Parameters<typeof reportGitHubPublicationTranscript>[0];
  warn: (message: string) => void;
}) {
  const scope = createGitHubPublicationWorkerScope(captureOpenClawStateWorkerContext());
  const coordinator = createGitHubPublicationCoordinator({
    ...params,
    assertCurrent: scope.assertCurrent,
    signal: scope.signal,
  });
  const ready = requirePersonalGitHubPublicationConfirmationAsync(
    params.placements.workspaceResultInstanceId(),
    scope.assertCurrent,
  );
  // Startup and every runtime operation join the same failure; avoid an unhandled early rejection.
  void ready.catch(() => {});
  const reportDeferred = async (
    publication: Parameters<typeof reportGitHubPublicationTranscript>[2],
  ) => {
    try {
      await reportGitHubPublicationTranscript(params.loadSessionRuntime, coordinator, publication);
    } catch (error) {
      params.warn(
        `GitHub publication result reporting deferred for ${publication.sessionId}: ${formatErrorMessage(error)}`,
      );
    }
  };
  const prepareAcceptedWorkspacePublication = async (claim: WorkerSessionTurnClaim) => {
    await ready;
    try {
      await coordinator.prepareClaimWorkspace(claim);
    } catch {
      await coordinator.deferClaimPreparationAsync(claim);
    }
  };
  const publishAcceptedWorkspace = async (claim: WorkerSessionTurnClaim) => {
    await ready;
    const placement = await params.placements.getAsync(claim.sessionId);
    if (!placement) {
      params.warn(`GitHub publication deferred because placement ${claim.sessionId} disappeared.`);
      return;
    }
    let results;
    try {
      results = await coordinator.processClaim(claim);
    } catch (error) {
      params.warn(
        `GitHub publication deferred for ${claim.sessionId}: ${formatErrorMessage(error)}`,
      );
      throw error;
    }
    for (const result of results) {
      if (result.status !== "published" && result.status !== "failed") {
        continue;
      }
      await reportDeferred({
        sessionId: placement.sessionId,
        sessionKey: placement.sessionKey,
        agentId: placement.agentId,
        result,
      });
    }
  };
  const reconcilePublications = async () => {
    await ready;
    try {
      await coordinator.deferOrphanedRequestsAsync();
      await coordinator.resumeSessionRequests();
    } catch (error) {
      params.warn(`GitHub publication recovery deferred: ${formatErrorMessage(error)}`);
    }
    for (const publication of await coordinator.listUnreportedResultsAsync()) {
      await reportDeferred(publication);
    }
  };
  return {
    ready,
    close: () => scope.close(),
    coordinator,
    prepareAcceptedWorkspacePublication,
    publishAcceptedWorkspace,
    reconcilePublications,
  };
}
