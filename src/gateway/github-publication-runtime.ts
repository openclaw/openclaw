import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import { createGitHubPublicationWorkerScope } from "../state/github-publication-worker.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { createNativeGitHubPublicationProvider } from "./github-publication-provider.js";
import { createGitHubPublicationRecoveryBackoff } from "./github-publication-recovery.js";
import {
  listRepositoryGitHubPublicationsAsync,
  listSharedGitHubPublicationsAsync,
  requirePersonalGitHubPublicationConfirmationAsync,
} from "./github-publication-store-async.js";
import type { RepositoryPublicationTranscriptRuntime } from "./github-publication-transcript.js";
import { reportRepositoryPublicationTranscript } from "./github-publication-transcript.js";
import { createGitHubPublicationCoordinator } from "./github-publication.js";
import type { RepositoryPublicationProvider } from "./repository-publication-contract.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

export function createGitHubPublicationRuntime(params: {
  context: OpenClawStateWorkerContext;
  signal: AbortSignal;
  provider: RepositoryPublicationProvider;
  formatReport: RepositoryPublicationProvider["formatReport"];
  placements: WorkerSessionPlacementStore;
  environments?: Parameters<typeof createGitHubPublicationCoordinator>[0]["environments"];
  getCommittedRuntimeConfig: () => OpenClawConfig;
  loadSessionRuntime: () => Promise<RepositoryPublicationTranscriptRuntime>;
  warn: (message: string) => void;
}) {
  const context = params.context;
  const scope = createGitHubPublicationWorkerScope(context);
  const work = new AsyncWorkScope();
  const admit = <T>(run: () => Promise<T>): Promise<T> => {
    if (work.isClosing) {
      throw new Error("Repository publication runtime is closing.");
    }
    return work.track(run);
  };
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
        listRepositoryGitHubPublicationsAsync({
          ownerProfileId: null,
          pending: true,
        }),
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
  const nativeCoordinator = createGitHubPublicationCoordinator({
    ...params,
    recovery,
    assertCurrent: () => {
      params.signal.throwIfAborted();
      scope.assertCurrent();
    },
    signal: AbortSignal.any([scope.signal, params.signal]),
  });
  // Existing native callers and service APIs share this operation lifetime. Receipt
  // custody stays open until the entire accepted operation has settled.
  const coordinator: typeof nativeCoordinator = {
    ...nativeCoordinator,
    performPullRequestAction: (...args) =>
      admit(() => nativeCoordinator.performPullRequestAction(...args)),
    inspectPullRequest: (...args) => admit(() => nativeCoordinator.inspectPullRequest(...args)),
    preparePullRequest: (...args) => admit(() => nativeCoordinator.preparePullRequest(...args)),
    refreshBase: (...args) => admit(() => nativeCoordinator.refreshBase(...args)),
    requestForClaimV2: (...args) => admit(() => nativeCoordinator.requestForClaimV2(...args)),
    requestForSessionV2: (...args) => admit(() => nativeCoordinator.requestForSessionV2(...args)),
    requestPersonalForSessionV2: (...args) =>
      admit(() => nativeCoordinator.requestPersonalForSessionV2(...args)),
    confirmPersonalV2: (...args) => admit(() => nativeCoordinator.confirmPersonalV2(...args)),
    prepareClaimWorkspace: (...args) =>
      admit(() => nativeCoordinator.prepareClaimWorkspace(...args)),
    processClaim: (...args) => admit(() => nativeCoordinator.processClaim(...args)),
    resumeSessionRequests: (...args) =>
      admit(() => nativeCoordinator.resumeSessionRequests(...args)),
    deferClaimPreparationAsync: (...args) =>
      admit(() => nativeCoordinator.deferClaimPreparationAsync(...args)),
    deferOrphanedRequestsAsync: (...args) =>
      admit(() => nativeCoordinator.deferOrphanedRequestsAsync(...args)),
    markReportedAsync: (...args) => admit(() => nativeCoordinator.markReportedAsync(...args)),
  };
  const ready = requirePersonalGitHubPublicationConfirmationAsync(
    params.placements.workspaceResultInstanceId(),
    scope.assertCurrent,
  );
  // Startup and every runtime operation join the same failure; avoid an unhandled early rejection.
  void work.track(() => ready).catch(() => {});
  const reportDeferred = async (
    publication: import("./github-publication.js").GitHubPublicationTranscriptReport,
  ) => {
    try {
      const lifecycleRevision = await nativeCoordinator.readReportLifecycleAsync(publication);
      const presentation = params.formatReport(publication.result);
      await reportRepositoryPublicationTranscript(
        params.loadSessionRuntime,
        (requestId) => nativeCoordinator.markReportedAsync(requestId),
        {
          ...publication,
          lifecycleRevision,
          requestId: publication.result.requestId,
          ...presentation,
        },
      );
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
      await nativeCoordinator.prepareClaimWorkspace(claim);
    } catch {
      await nativeCoordinator.deferClaimPreparationAsync(claim);
    }
  };
  const publishAcceptedWorkspace = async (claim: WorkerSessionTurnClaim) => {
    await ready;
    // The accepted snapshot is durable before this handoff. Release its claim binding
    // through the existing writer; the lifecycle sweep publishes after workspace
    // settlement, including after a restart, without holding settlement on network I/O.
    await coordinator.deferClaimPreparationAsync(claim);
    reconcileNeeded = true;
  };
  const reconcilePublications = async (isStopping?: () => boolean) => {
    // Retain accepted and uncertain outcomes while the native provider is unavailable.
    // Re-enable joins the existing recovery owner instead of inventing a failure or retry.
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
    resolveGitAuthor(this: void, agentId: string) {
      return params.provider.resolveGitAuthor?.(agentId);
    },
    ready,
    close: async () => {
      stopFacts();
      await work.drain();
      recovery.shared.clear();
      recovery.repository.clear();
      await scope.close();
    },
    coordinator,
    performPullRequestAction: (
      input: Parameters<RepositoryPublicationProvider["performPullRequestAction"]>[0],
    ) => admit(() => params.provider.performPullRequestAction(input)),
    inspectPullRequest: (
      input: Parameters<RepositoryPublicationProvider["inspectPullRequest"]>[0],
    ) => admit(() => params.provider.inspectPullRequest(input)),
    prepareAcceptedWorkspacePublication: (claim: WorkerSessionTurnClaim) =>
      admit(() => prepareAcceptedWorkspacePublication(claim)),
    publishAcceptedWorkspace: (claim: WorkerSessionTurnClaim) =>
      admit(() => publishAcceptedWorkspace(claim)),
    reconcilePublications: (isStopping?: () => boolean) =>
      admit(() => reconcilePublications(isStopping)),
  };
}

export function createNativeGitHubPublicationRuntime(params: {
  scheduler: GatewayScheduler;
  placements: WorkerSessionPlacementStore;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  warn: (message: string) => void;
  loadSessionRuntime: () => Promise<RepositoryPublicationTranscriptRuntime>;
}) {
  const context = captureOpenClawStateWorkerContext();
  const signal = params.scheduler.signal;
  const provider = createNativeGitHubPublicationProvider({
    signal,
    assertCurrent: () => {
      signal.throwIfAborted();
      context.admission.assertCurrent();
    },
    getConfig: params.getCommittedRuntimeConfig,
  });
  return createGitHubPublicationRuntime({
    ...params,
    context,
    signal,
    provider,
    formatReport: provider.formatReport,
    loadSessionRuntime: params.loadSessionRuntime,
  });
}
