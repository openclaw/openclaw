import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import { createGitHubPublicationWorkerScope } from "../state/github-publication-worker.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createGitHubPublicationRecoveryBackoff } from "./github-publication-recovery.js";
import {
  listRepositoryGitHubPublicationsAsync,
  listSharedGitHubPublicationsAsync,
  requirePersonalGitHubPublicationConfirmationAsync,
} from "./github-publication-store-async.js";
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
  const context = captureOpenClawStateWorkerContext();
  const scope = createGitHubPublicationWorkerScope(context);
  const recovery = {
    shared: createGitHubPublicationRecoveryBackoff(),
    repository: createGitHubPublicationRecoveryBackoff(),
  };
  const pendingRequests = new Set<string>();
  let pendingKnown = false;
  let reconcileNeeded = true;
  let loadingUpdates: Map<string, boolean> | undefined;
  const updatePending = (key: string, pending: boolean) => {
    if (pending) {
      pendingRequests.add(key);
    } else {
      pendingRequests.delete(key);
    }
    loadingUpdates?.set(key, pending);
  };
  const stopFacts = githubPublicationReceipts.subscribeFacts((change) => {
    if (change.kind === "unknown" && change.identity === context.admission.identity.key) {
      pendingKnown = false;
      reconcileNeeded = true;
    }
    if (
      change.kind !== "committed" ||
      change.receipt.source.identity !== context.admission.identity.key
    ) {
      return;
    }
    for (const [key, fact] of change.receipt.facts) {
      if (fact.kind === "unknown") {
        pendingKnown = false;
        reconcileNeeded = true;
      } else if (fact.kind === "absent") {
        updatePending(key, false);
      } else if (fact.kind === "postimage" && "status" in fact.value) {
        const row = fact.value;
        updatePending(
          key,
          ((row.status === "requested" || row.status === "publishing") &&
            row.identity_source !== "personal") ||
            ((row.status === "published" || row.status === "failed") &&
              row.reported_at_ms === null),
        );
        reconcileNeeded = true;
      }
    }
  });
  const loadPendingRequests = async () => {
    const updates = new Map<string, boolean>();
    loadingUpdates = updates;
    pendingKnown = true;
    try {
      const [shared, repository] = await Promise.all([
        listSharedGitHubPublicationsAsync({ pending: true }),
        listRepositoryGitHubPublicationsAsync({ ownerProfileId: null, pending: true }),
      ]);
      pendingRequests.clear();
      for (const row of shared) {
        pendingRequests.add(JSON.stringify(["shared", row.request_id]));
      }
      for (const row of repository) {
        pendingRequests.add(JSON.stringify(["repository", row.request_id]));
      }
      // Receipts committed while the startup snapshot loaded take precedence over that snapshot.
      for (const [key, pending] of updates) {
        updatePending(key, pending);
      }
      // This invocation can skip empty recovery only until a receipt changes the loaded facts.
      return (kind: "shared" | "repository") =>
        (kind === "shared" ? shared : repository).length === 0 &&
        updates.size === 0 &&
        pendingKnown;
    } catch (error) {
      pendingKnown = false;
      throw error;
    }
  };
  const coordinator = createGitHubPublicationCoordinator({
    ...params,
    recovery,
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
      return true;
    } catch (error) {
      params.warn(
        `GitHub publication result reporting deferred for ${publication.sessionId}: ${formatErrorMessage(error)}`,
      );
      return false;
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
  const reconcilePublications = async (isStopping?: () => boolean) => {
    if (isStopping?.()) {
      return;
    }
    await ready;
    if (isStopping?.()) {
      return;
    }
    try {
      const isPendingEmpty = !pendingKnown ? await loadPendingRequests() : undefined;
      if (isStopping?.()) {
        return;
      }
      if (!reconcileNeeded && pendingRequests.size === 0) {
        recovery.shared.clear();
        recovery.repository.clear();
        return;
      }
      reconcileNeeded = false;
      try {
        await coordinator.deferOrphanedRequestsAsync(isPendingEmpty);
        if (!isStopping?.()) {
          await coordinator.resumeSessionRequests(isStopping, isPendingEmpty);
        }
      } catch (error) {
        reconcileNeeded = true;
        params.warn(`GitHub publication recovery deferred: ${formatErrorMessage(error)}`);
      }
      if (isStopping?.()) {
        reconcileNeeded = true;
        return;
      }
      try {
        for (const publication of await coordinator.listUnreportedResultsAsync()) {
          if (isStopping?.()) {
            reconcileNeeded = true;
            break;
          }
          if (!(await reportDeferred(publication))) {
            reconcileNeeded = true;
          }
        }
      } catch (error) {
        reconcileNeeded = true;
        throw error;
      }
    } finally {
      loadingUpdates = undefined;
    }
  };
  return {
    ready,
    close: () => {
      stopFacts();
      recovery.shared.clear();
      recovery.repository.clear();
      return scope.close();
    },
    coordinator,
    prepareAcceptedWorkspacePublication,
    publishAcceptedWorkspace,
    reconcilePublications,
  };
}
