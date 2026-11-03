import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { acquireWorktreeRunLease } from "../agents/worktrees/run-lease.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import type { GitHubPublicationRow as PublicationRow } from "../state/github-publication-read.types.js";
import { readGitHubPublicationSessionLifecycleInWorker } from "../state/github-publication-session-lifecycles.js";
import {
  RepositoryPublicationAuthorityLostError,
  RepositoryPublicationRequesterUnavailableError,
} from "./github-publication-errors.js";
import type { executeGitHubPublication } from "./github-publication-executor.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import type { assertPublicationChangePermission as assertGitHubPublicationWorkflowChangesAllowed } from "./github-publication-policy.js";
import { projectGitHubPublicationResult as publicationResult } from "./github-publication-receipt.js";
import { readGitHubPublicationRequestInWorker } from "./github-publication-recovery.js";
import type {
  reconcileGitHubPublication,
  observeGitHubPublication,
} from "./github-publication-recovery.js";
import { restoreGitHubPublicationRequester } from "./github-publication-requester.js";
import {
  claimGitHubPublicationExecutionAsync,
  createGitHubPublicationExecutionStoreAsync,
  deferGitHubPublicationRequestsAsync,
} from "./github-publication-store-async.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

// Existing native receipts keep their GitHub format; this host owner never transports credentials.
const activePublicationExecutions = new Map<string, Promise<SessionGitHubPublicationResult>>();

/** The native adapter owns remote policy and transport; the host retains accepted work and recovery. */
export function createRepositoryPublicationHostExecution(params: {
  placements: WorkerSessionPlacementStore;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  assertCurrent: () => void;
  signal: AbortSignal;
  adapter: {
    execute: (
      input: Omit<
        Parameters<typeof executeGitHubPublication<PublicationRow>>[0],
        "provider" | "config"
      >,
    ) => ReturnType<typeof executeGitHubPublication<PublicationRow>>;
    reconcile: (
      input: Omit<Parameters<typeof reconcileGitHubPublication<PublicationRow>>[0], "provider">,
    ) => ReturnType<typeof reconcileGitHubPublication<PublicationRow>>;
    observe: (
      input: Omit<Parameters<typeof observeGitHubPublication<PublicationRow>>[0], "provider">,
    ) => ReturnType<typeof observeGitHubPublication<PublicationRow>>;
    assertWorkflowChangesAllowed: typeof assertGitHubPublicationWorkflowChangesAllowed;
  };
}) {
  const instanceId = params.placements.workspaceResultInstanceId();
  const { assertCurrent, signal } = params;
  return (
    initial: PublicationRow,
    validateExecution: () => boolean,
    assertInvocationCurrent?: () => void,
    invocationSignal?: AbortSignal,
    recoveryResult?: SessionGitHubPublicationResult,
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
              throw new RepositoryPublicationRequesterUnavailableError();
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
                throw new RepositoryPublicationAuthorityLostError(
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
                  throw new RepositoryPublicationAuthorityLostError(
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
            return await params.adapter.execute({
              initial: claimed,
              recoveryResult:
                recoveryResult ??
                (claimed.head_commit
                  ? () =>
                      params.adapter.observe({
                        initial: claimed,
                        validateCustody,
                        beforeRetry: true,
                      })
                  : undefined),
              requester: getRequester,
              requesterProfileId: () => {
                const actor = getRequester().snapshot.actor;
                return actor.kind === "operator" ? actor.profileId : undefined;
              },
              validateCustody,
              assertWorkflowChangesAllowed: () =>
                params.adapter.assertWorkflowChangesAllowed(getRequester()),
              prepareAuthority: async () => {
                if (!validateCustody()) {
                  throw new RepositoryPublicationAuthorityLostError(
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
                  throw new RepositoryPublicationAuthorityLostError(
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
            if (!(error instanceof RepositoryPublicationRequesterUnavailableError)) {
              throw error;
            }
            if (!validateCustody()) {
              throw new RepositoryPublicationAuthorityLostError(
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
              throw new RepositoryPublicationAuthorityLostError(
                "GitHub publication execution custody changed during reconciliation.",
              );
            }
            // A fresh execution knows whether it dispatched any GitHub write. Historical
            // head facts still require observation; an absent response proves nothing.
            if (claimed.head_commit !== null || dispatched) {
              const observed = await params.adapter.reconcile({
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
              throw new RepositoryPublicationAuthorityLostError(
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
}
