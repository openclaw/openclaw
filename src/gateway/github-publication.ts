import { randomUUID } from "node:crypto";
import type {
  SessionGitHubPublicationResult,
  SessionGitHubStatusResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { acquireWorktreeRunLease } from "../agents/worktrees/run-lease.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import type { GitHubPublicationRow as PublicationRow } from "../state/github-publication-read.types.js";
import { readGitHubPublicationSessionLifecycleInWorker } from "../state/github-publication-session-lifecycles.js";
import { createGitHubPublicationWorkerScope } from "../state/github-publication-worker.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createPersonalGitHubPublicationCoordinator } from "./github-personal-publication.js";
import {
  assertExpectedSharedGitHubPublisher,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  readGitHubPublicationWorktreeOwner,
  prepareGitHubPublicationWorkspaceOwner,
} from "./github-publication-availability.js";
import {
  createGitHubPublicationCoordinatorMethods,
  type GitHubPublicationClaimRequest,
  type GitHubPublicationClaimRequestV2,
} from "./github-publication-coordinator-methods.js";
import { GitHubPublicationAuthorityLostError } from "./github-publication-execution-identity.js";
import {
  executeGitHubPublication,
  reconcileGitHubPublication,
} from "./github-publication-executor.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import {
  digestGitHubPublicationRequest as digestRequest,
  projectGitHubPublicationResult as publicationResult,
} from "./github-publication-receipt.js";
import { readGitHubPublicationRequestInWorker } from "./github-publication-recovery.js";
import { insertGitHubPublicationRequestAsync } from "./github-publication-request-async.js";
import {
  restoreGitHubPublicationRequester,
  isGitHubPublicationRequesterV2,
} from "./github-publication-requester.js";
import { bindGitHubPublicationSourceLifetime } from "./github-publication-source.js";
import {
  claimGitHubPublicationExecutionAsync,
  createGitHubPublicationExecutionStoreAsync,
  deferGitHubPublicationRequestsAsync,
  readGitHubPublicationRequestAsync,
  runGitHubPublicationMaintenanceAsync,
} from "./github-publication-store-async.js";
import { assertGitHubPublicationWorkflowChangesAllowed } from "./github-publication-workflows.js";
import {
  prepareGitHubPublicationClaimWorkspace,
  sameWorktree,
} from "./github-publication-workspace.js";
import { createRepositoryGitHubPublicationCoordinator } from "./github-repository-publication.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

const activePublicationExecutions = new Map<string, Promise<SessionGitHubPublicationResult>>();

function sameClaim(row: PublicationRow, claim: WorkerSessionTurnClaim): boolean {
  return (
    row.claim_id === claim.claimId &&
    row.run_id === claim.runId &&
    row.placement_generation === claim.placementGeneration &&
    row.environment_id === (claim.owner.environmentId ?? null) &&
    row.owner_epoch === (claim.owner.ownerEpoch ?? null)
  );
}

export type GitHubPublicationCoordinator = ReturnType<typeof createGitHubPublicationCoordinator>;

export function createGitHubPublicationCoordinator(params: {
  placements: WorkerSessionPlacementStore;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  assertCurrent?: () => void;
  signal?: AbortSignal;
}) {
  const instanceId = params.placements.workspaceResultInstanceId();
  const scope = createGitHubPublicationWorkerScope(captureOpenClawStateWorkerContext());
  const assertCurrent = params.assertCurrent ?? scope.assertCurrent;
  const signal = params.signal ?? scope.signal;

  const requestForClaim = async (
    request: GitHubPublicationClaimRequestV2,
  ): Promise<SessionGitHubPublicationResult> => {
    const assertRequester = request.requester.assertCurrent;
    const placement = await params.placements.getAsync(request.claim.sessionId);
    assertRequester();
    if (!params.placements.validateTurnClaim(request.claim)) {
      throw new Error("GitHub publication lost the live session turn claim.");
    }
    if (
      !placement ||
      placement.sessionKey !== request.sessionKey ||
      placement.agentId !== request.agentId
    ) {
      throw new Error("GitHub publication session identity changed.");
    }
    const admitted = await readGitHubPublicationWorktreeOwner({
      sessionId: request.claim.sessionId,
      sessionKey: request.sessionKey,
      agentId: request.agentId,
    });
    assertRequester();
    const identity = await prepareCurrentGitHubPublicationIdentity(request.agentId);
    assertRequester();
    const existing = await readGitHubPublicationRequestAsync({
      sessionId: request.claim.sessionId,
      idempotencyKey: request.idempotencyKey,
    });
    assertRequester();
    assertExpectedSharedGitHubPublisher(
      request.expectedPublisher,
      { source: identity.source, ...identity.account },
      {
        idempotencyKey: request.idempotencyKey,
        hasRequest: () => Boolean(existing),
      },
    );
    const worktreeOwner = admitted;
    const { worktree } = worktreeOwner;
    assertRequester();
    if (!params.placements.validateTurnClaim(request.claim)) {
      throw new Error("GitHub publication lost the live session turn claim after verification.");
    }
    if (!matchesCurrentGitHubPublicationIdentity({ agentId: request.agentId, identity })) {
      throw new Error("GitHub publication identity changed.");
    }
    const requestDigest = digestRequest({
      sessionId: request.claim.sessionId,
      idempotencyKey: request.idempotencyKey,
      title: request.title,
      body: request.body,
    });
    const now = Date.now();
    const requestId = randomUUID();
    const input = {
      request: {
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        idempotencyKey: request.idempotencyKey,
        title: request.title,
        body: request.body,
      },
      requestId,
      requestDigest,
      now,
      identity: {
        source: identity.source,
        profileId: identity.profileId,
        account: identity.account,
      },
      worktree: {
        id: worktree.id,
        repoFingerprint: worktree.repoFingerprint,
        branch: worktree.branch,
      },
      sessionId: request.claim.sessionId,
      lifecycleRevision: admitted.loaded.entry?.lifecycleRevision ?? null,
      requester: request.requester.snapshot,
      claim: request.claim,
    };
    let row: PublicationRow;
    {
      const source = await request.requester.prepareSource({
        agentId: request.agentId,
        sessionKey: request.sessionKey,
        sessionId: request.claim.sessionId,
        lifecycleRevision: input.lifecycleRevision,
        worktreeId: worktree.id,
      });
      try {
        assertCurrent();
        assertRequester();
        worktreeOwner.assertCurrent();
        if (
          !params.placements.validateTurnClaim(request.claim) ||
          !matchesCurrentGitHubPublicationIdentity({ agentId: request.agentId, identity })
        ) {
          throw new Error("GitHub publication authority changed before recording.");
        }
        bindGitHubPublicationSourceLifetime(source, signal);
        row = await insertGitHubPublicationRequestAsync(input, source);
      } finally {
        await source.release();
      }
    }
    if (!sameClaim(row, request.claim)) {
      throw new Error("GitHub publication idempotency key was reused.");
    }
    return publicationResult(row);
  };

  const processRow = (
    initial: PublicationRow,
    validateExecution: () => boolean,
    assertInvocationCurrent?: () => void,
    invocationSignal?: AbortSignal,
  ): Promise<SessionGitHubPublicationResult> => {
    if (initial.status === "published" || initial.status === "failed") {
      return Promise.resolve(publicationResult(initial));
    }
    const executionKey = `${instanceId}\0${initial.request_id}`;
    return getOrCreatePromise(
      activePublicationExecutions,
      executionKey,
      () =>
        params.placements.withWorkspaceExclusion(initial.session_id, async (assertOwned) => {
          const assertCustody = () => {
            assertCurrent();
            assertOwned();
          };
          const claimed = await claimGitHubPublicationExecutionAsync(
            initial.request_id,
            instanceId,
            assertCurrent,
          );
          if (claimed.status === "published" || claimed.status === "failed") {
            return publicationResult(claimed);
          }
          const lease = await acquireWorktreeRunLease(claimed.worktree_id);
          const validateCustody = () => {
            assertCustody();
            return validateExecution();
          };
          let effect: SessionGitHubPublicationResult["effect"];
          let dispatched = false;
          let requester: Awaited<ReturnType<typeof restoreGitHubPublicationRequester>> | undefined;
          let lifecycleRevision: string | null | undefined;
          const revokeInvocation = () => requester?.release();
          invocationSignal?.addEventListener("abort", revokeInvocation, { once: true });
          signal.addEventListener("abort", revokeInvocation, { once: true });
          const getRequester = () => {
            if (!requester) {
              throw new GitHubPublicationRequesterUnavailableError();
            }
            return requester;
          };
          const executionStore = createGitHubPublicationExecutionStoreAsync(instanceId, {
            assertCustody: assertCurrent,
            assertAction() {
              assertCustody();
              signal.throwIfAborted();
              invocationSignal?.throwIfAborted();
              getRequester().signal.throwIfAborted();
            },
            async prepareSource() {
              signal.throwIfAborted();
              invocationSignal?.throwIfAborted();
              assertInvocationCurrent?.();
              if (!validateCustody() || lifecycleRevision === undefined) {
                throw new GitHubPublicationAuthorityLostError(
                  "GitHub publication source custody changed.",
                );
              }
              const source = await getRequester().prepareSource({
                agentId: claimed.agent_id,
                sessionKey: claimed.session_key,
                sessionId: claimed.session_id,
                lifecycleRevision,
                worktreeId: claimed.worktree_id,
              });
              try {
                invocationSignal?.throwIfAborted();
                assertInvocationCurrent?.();
                if (!validateCustody()) {
                  throw new GitHubPublicationAuthorityLostError(
                    "GitHub publication source custody changed.",
                  );
                }
                return source;
              } catch (error) {
                await source.release();
                throw error;
              }
            },
          });
          try {
            assertOwned();
            return await executeGitHubPublication({
              initial: claimed,
              validateCustody,
              assertWorkflowChangesAllowed: () =>
                assertGitHubPublicationWorkflowChangesAllowed(getRequester()),
              prepareAuthority: async () => {
                if (!validateCustody()) {
                  throw new GitHubPublicationAuthorityLostError(
                    "GitHub publication execution custody changed before requester preparation.",
                  );
                }
                const lifecycle = await readGitHubPublicationSessionLifecycleInWorker({
                  publicationKind: "shared",
                  requestId: claimed.request_id,
                }).catch((cause: unknown) => {
                  throw new GitHubPublicationRecoveryPendingError(
                    "GitHub publication requester metadata is unavailable; retry recovery.",
                    { cause },
                  );
                });
                if (!validateCustody()) {
                  throw new GitHubPublicationAuthorityLostError(
                    "GitHub publication execution custody changed during requester preparation.",
                  );
                }
                assertInvocationCurrent?.();
                invocationSignal?.throwIfAborted();
                signal.throwIfAborted();
                requester = await restoreGitHubPublicationRequester(
                  lifecycle?.requester_authority_json,
                  { sessionKey: claimed.session_key, agentId: claimed.agent_id },
                  params.getCommittedRuntimeConfig,
                );
                lifecycleRevision = lifecycle?.lifecycle_revision;
                signal.throwIfAborted();
                invocationSignal?.throwIfAborted();
              },
              validateAuthority: () => {
                if (!validateCustody()) {
                  return false;
                }
                getRequester().assertCurrent();
                assertInvocationCurrent?.();
                return true;
              },
              recordEffect: (kind, observed) => {
                dispatched ||= observed === undefined;
                effect = {
                  kind,
                  status: observed?.headCommit || observed?.url ? "observed" : "dispatched",
                  ...observed,
                };
              },
              bindWorkspaceSnapshot: (input) => executionStore.bindWorkspaceSnapshot(input),
              updatePublishingFacts: (input) => executionStore.updatePublishingFacts(input),
              complete: (row, result) => executionStore.complete(row, result),
              defer: async (row) => {
                await deferGitHubPublicationRequestsAsync({ kind: "request", row }, assertCurrent);
                const deferred = await readGitHubPublicationRequestInWorker(row.request_id);
                if (!deferred) {
                  throw new Error("GitHub publication request disappeared.");
                }
                return deferred;
              },
            });
          } catch (error) {
            if (!(error instanceof GitHubPublicationRequesterUnavailableError)) {
              throw error;
            }
            if (!validateCustody()) {
              throw new GitHubPublicationAuthorityLostError(
                "GitHub publication execution custody changed before reconciliation.",
              );
            }
            const current = await readGitHubPublicationRequestInWorker(claimed.request_id).catch(
              (cause: unknown) => {
                throw new GitHubPublicationRecoveryPendingError(
                  "GitHub publication receipt is unavailable; retry recovery.",
                  { cause },
                );
              },
            );
            if (!current || !validateCustody()) {
              throw new GitHubPublicationAuthorityLostError(
                "GitHub publication execution custody changed during reconciliation.",
              );
            }
            // A fresh execution knows whether it dispatched any GitHub write. Historical
            // head facts still require observation; an absent response proves nothing.
            if (claimed.head_commit !== null || dispatched) {
              const observed = await reconcileGitHubPublication({
                initial: current,
                validateCustody,
                complete: (row, result) => executionStore.complete(row, result),
                pushOnly:
                  claimed.head_commit === null && effect?.kind === "push"
                    ? effect.status === "observed" && effect.headCommit === current.head_commit
                      ? "observed"
                      : "dispatched"
                    : undefined,
              });
              if (observed) {
                return observed;
              }
            }
            if (!validateCustody()) {
              throw new GitHubPublicationAuthorityLostError(
                "GitHub publication execution custody changed during reconciliation.",
              );
            }
            return publicationResult(
              await executionStore.complete(current, {
                requestId: current.request_id,
                status: "failed",
                ...error.failure,
                message: error.message,
              }),
            );
          } finally {
            signal.removeEventListener("abort", revokeInvocation);
            invocationSignal?.removeEventListener("abort", revokeInvocation);
            requester?.release();
            await lease.release();
          }
        }),
      { evictOnSettled: true },
    );
  };

  const repository = createRepositoryGitHubPublicationCoordinator({
    ...params,
    assertCurrent,
    signal,
  });
  const personal = createPersonalGitHubPublicationCoordinator(
    params.placements,
    assertCurrent,
    signal,
  );
  const methods = createGitHubPublicationCoordinatorMethods({
    placements: params.placements,
    assertCurrent,
    requestForClaimV2: requestForClaim,
    getCommittedRuntimeConfig: params.getCommittedRuntimeConfig,
    signal,
    sameWorktree,
    processRow,
  });
  return {
    ...methods,
    ...personal,
    /** @deprecated Use requestForClaimV2; removed in the next Plugin SDK major. */
    requestForClaim: async (
      _request: GitHubPublicationClaimRequest,
    ): Promise<SessionGitHubPublicationResult> => {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "requestForClaim",
        replacement: "requestForClaimV2",
      });
      throw new Error("Use requestForClaimV2 with a host-prepared requester.");
    },
    requestForClaimV2: async (request: GitHubPublicationClaimRequestV2) => {
      if (!isGitHubPublicationRequesterV2(request.requester)) {
        throw new Error("GitHub publication requires a host-prepared V2 requester.");
      }
      assertCurrent();
      return (
        await prepareGitHubPublicationWorkspaceOwner({
          sessionId: request.claim.sessionId,
          sessionKey: request.sessionKey,
          agentId: request.agentId,
        })
      ).initial.kind === "repository"
        ? repository.requestForClaimV2(request)
        : requestForClaim(request);
    },
    async prepareClaimWorkspace(claim: WorkerSessionTurnClaim) {
      await prepareGitHubPublicationClaimWorkspace(
        { placements: params.placements, assertCurrent },
        claim,
      );
      await repository.prepareClaimWorkspace(claim);
    },
    /** @deprecated Use deferClaimPreparationAsync; removed in the next Plugin SDK major. */
    deferClaimPreparation(_claim: WorkerSessionTurnClaim) {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "deferClaimPreparation",
        replacement: "deferClaimPreparationAsync",
      });
      throw new Error("Use deferClaimPreparationAsync and await completion.");
    },
    async deferClaimPreparationAsync(claim: WorkerSessionTurnClaim) {
      await runGitHubPublicationMaintenanceAsync({ operation: "deferClaim", claim }, assertCurrent);
    },
    /** @deprecated Use requestForSessionV2; removed in the next Plugin SDK major. */
    async requestForSession(
      _input: import("./github-publication-coordinator-methods.js").GitHubPublicationSessionRequest,
    ): Promise<SessionGitHubPublicationResult> {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "requestForSession",
        replacement: "requestForSessionV2",
      });
      throw new Error("Use requestForSessionV2 with a host-prepared requester.");
    },
    async requestForSessionV2(input: Parameters<typeof methods.requestForSessionV2>[0]) {
      if (!isGitHubPublicationRequesterV2(input.requester)) {
        throw new Error("GitHub publication requires a host-prepared V2 requester.");
      }
      assertCurrent();
      if (!input.sessionKey) {
        throw new Error("GitHub publication requires an authoritative session.");
      }
      const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
        cfg: params.getCommittedRuntimeConfig(),
        key: input.sessionKey,
        agentId: input.agentId,
        assertActive: assertCurrent,
      });
      return loaded.entry?.repositoryWorkspaceId
        ? repository.requestForSessionV2(input)
        : methods.requestForSessionV2(input);
    },
    /** @deprecated Use requestPersonalForSessionV2; removed in the next Plugin SDK major. */
    async requestPersonalForSession(
      ..._args: Parameters<typeof personal.requestPersonalForSession>
    ): Promise<SessionGitHubPublicationResult> {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "requestPersonalForSession",
        replacement: "requestPersonalForSessionV2",
      });
      throw new Error("Use requestPersonalForSessionV2 with a host-prepared action.");
    },
    async requestPersonalForSessionV2(
      ...args: Parameters<typeof personal.requestPersonalForSessionV2>
    ) {
      return (await prepareGitHubPublicationWorkspaceOwner(args[1])).initial.kind === "repository"
        ? repository.requestPersonalForSessionV2(...args)
        : personal.requestPersonalForSessionV2(...args);
    },
    async sharedStatus(...args: Parameters<typeof methods.sharedStatus>) {
      return (await repository.sharedStatus(...args)) ?? (await methods.sharedStatus(...args));
    },
    async latestShared(...args: Parameters<typeof methods.latestShared>) {
      return (await repository.latestShared(...args)) ?? (await methods.latestShared(...args));
    },
    preparePersonalStatus: repository.preparePersonalStatus,
    /** @deprecated Use personalStatusAsync and await completion. */
    personalStatus(
      ..._args: Parameters<typeof repository.personalStatusAsync>
    ): SessionGitHubStatusResult {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "personalStatus",
        replacement: "personalStatusAsync",
      });
      throw new Error("Use personalStatusAsync and await completion.");
    },
    async personalStatusAsync(...args: Parameters<typeof repository.personalStatusAsync>) {
      return (
        (await repository.personalStatusAsync(...args)) ??
        personal.personalStatusAsync(args[0], args[1], args[2])
      );
    },
    async personalPending(...args: Parameters<typeof personal.personalPending>) {
      return (await repository.personalPending(...args)) ?? personal.personalPending(...args);
    },
    /** @deprecated Use confirmPersonalV2; removed in the next Plugin SDK major. */
    confirmPersonal(
      ..._args: Parameters<typeof personal.confirmPersonal>
    ): Promise<SessionGitHubPublicationResult> {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "confirmPersonal",
        replacement: "confirmPersonalV2",
      });
      throw new Error("Use confirmPersonalV2 with a host-prepared action.");
    },
    async confirmPersonalV2(...args: Parameters<typeof personal.confirmPersonalV2>) {
      return (await repository.hasRequestAsync(args[0].requestId))
        ? repository.confirmPersonalV2(...args)
        : personal.confirmPersonalV2(...args);
    },
    async processClaim(claim: WorkerSessionTurnClaim) {
      return [...(await methods.processClaim(claim)), ...(await repository.processClaim(claim))];
    },
    async resumeSessionRequests() {
      const failures: unknown[] = [];
      for (const coordinator of [methods, repository]) {
        try {
          await coordinator.resumeSessionRequests();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          failures
            .map((error) => (error instanceof Error ? error.message : String(error)))
            .join("; "),
        );
      }
    },
    /** @deprecated Use deferOrphanedRequestsAsync; removed in the next Plugin SDK major. */
    deferOrphanedRequests(): void {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "deferOrphanedRequests",
        replacement: "deferOrphanedRequestsAsync",
      });
      throw new Error("Use deferOrphanedRequestsAsync and await completion.");
    },
    async deferOrphanedRequestsAsync(): Promise<void> {
      await methods.deferOrphanedRequestsAsync();
      await repository.deferOrphanedRequestsAsync();
    },
    /** @deprecated Use listUnreportedResultsAsync; removed in the next Plugin SDK major. */
    listUnreportedResults(): Array<{
      sessionId: string;
      sessionKey: string;
      agentId: string;
      result: SessionGitHubPublicationResult;
    }> {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "listUnreportedResults",
        replacement: "listUnreportedResultsAsync",
      });
      throw new Error("Use listUnreportedResultsAsync and await completion.");
    },
    async listUnreportedResultsAsync() {
      return [
        ...(await methods.listUnreportedResultsAsync()),
        ...(await repository.listUnreportedResultsAsync()),
      ];
    },
    /** @deprecated Use readAsync and await completion. */
    read(_requestId: string): SessionGitHubPublicationResult | undefined {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "read",
        replacement: "readAsync",
      });
      throw new Error("Use readAsync and await completion.");
    },
    async readAsync(requestId: string) {
      return (await repository.readAsync(requestId)) ?? methods.readAsync(requestId);
    },
    /** @deprecated Use markReportedAsync; removed in the next Plugin SDK major. */
    markReported(_requestId: string) {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "markReported",
        replacement: "markReportedAsync",
      });
      throw new Error("Use markReportedAsync and await completion.");
    },
    async markReportedAsync(requestId: string) {
      await runGitHubPublicationMaintenanceAsync({ operation: "report", requestId }, assertCurrent);
    },
  };
}
