import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import { decodeGitHubPublicationRequester } from "../state/github-publication-requester.js";
import { readGitHubPublicationInWorker } from "../state/github-publication-worker.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { OpenClawStateLeaseAcquisitionError } from "../state/openclaw-state-lease-error.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { matchesRepositoryGitHubPublicationClaim } from "./github-publication-defer.kernel.js";
import { createGitHubPublicationExecutionIdentity } from "./github-publication-execution-identity.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import { reconcileGitHubPublicationPullRequest } from "./github-publication-pull-requests.js";
import { projectGitHubPublicationResult } from "./github-publication-receipt.js";
import { restoreGitHubPublicationRequester } from "./github-publication-requester.js";
import {
  listRepositoryGitHubPublicationsAsync,
  deferRepositoryGitHubPublicationClaimsAsync,
  bindRepositoryGitHubPublicationCheckpointAsync,
  failStaleRepositoryGitHubPublicationAsync,
  type GitHubPublicationTransitionAuthority,
  type RepositoryGitHubPublicationExecutionAsync,
} from "./github-publication-store-async.js";
import {
  deferRepositoryGitHubPublicationClaims,
  listRepositoryGitHubPublications,
  terminalRepositoryGitHubPublication,
  type RepositoryGitHubPublicationExecution,
} from "./github-repository-publication-store.js";
import {
  assertReceiptOwner,
  captureCheckpoint,
  resolveReceiptOwner,
} from "./github-repository-publication-workspace.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";
import { SessionWorkspaceReservationBusyError } from "./worker-environments/placement-workspace-reservation.kernel.js";

export async function settleDeniedRepositoryGitHubPublication(params: {
  execution: RepositoryGitHubPublicationExecutionAsync | RepositoryGitHubPublicationExecution;
  assertCustody: () => void;
  error: GitHubPublicationRequesterUnavailableError;
}): Promise<SessionGitHubPublicationResult> {
  const { execution, assertCustody, error } = params;
  assertCustody();
  if (!execution.ownsExecution()) {
    throw new GitHubPublicationRecoveryPendingError(
      "GitHub publication execution custody changed during reconciliation.",
    );
  }
  const row = await readRepositoryGitHubPublicationInWorker(execution.row.request_id).catch(
    (cause: unknown) => {
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication receipt is unavailable; retry recovery.",
        { cause },
      );
    },
  );
  assertCustody();
  if (!row || !execution.ownsExecution()) {
    throw new GitHubPublicationRecoveryPendingError(
      "GitHub publication execution custody changed during reconciliation.",
    );
  }
  const requester = decodeGitHubPublicationRequester(row.requester_authority_json);
  // Git objects may exist before last_effect; branch and PR dispatch always record it first.
  if (row.last_effect !== null || (!requester && row.head_commit !== null)) {
    if (
      !row.repository ||
      !row.push_repository ||
      !row.base_branch ||
      !row.head_commit ||
      !row.source_head_commit ||
      !row.workspace_tree
    ) {
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication's recorded effects lack the facts needed for recovery; inspect the original target before requesting another publication.",
      );
    }
    const preparedOwner = await getSessionRepositoryWorkspaceStore().prepare(row.workspace_id);
    assertCustody();
    const { assertCurrent, refreshIdentity } = createGitHubPublicationExecutionIdentity({
      row,
      validateAuthority: () => {
        assertCustody();
        return execution.ownsExecution();
      },
      assertWorkspace: () => {
        assertReceiptOwner(row, preparedOwner);
      },
    });
    let url: string | undefined;
    try {
      assertCurrent();
      const knownPullRequestUrls = await readKnownRepositoryGitHubPublicationPullRequestUrls(row);
      assertCurrent();
      url = await reconcileGitHubPublicationPullRequest({
        requestId: row.request_id,
        pushRepository: row.push_repository,
        repository: row.repository,
        pushOwner: row.push_repository.split("/")[0]!,
        branch: row.branch,
        baseBranch: row.base_branch,
        headCommit: row.head_commit,
        workspaceTree: row.workspace_tree,
        parentCommit: row.previous_head_commit ?? row.source_head_commit,
        marker: `<!-- openclaw-publication:${row.request_id} -->`,
        knownPullRequestUrls,
        refreshIdentity,
        assertCurrent,
        // Older writers could overwrite a prior PR phase with a ref observation.
        pushOnly:
          requester && row.last_effect === "push"
            ? row.effect_state === "observed" && row.pushed_head_commit === row.head_commit
              ? "observed"
              : "dispatched"
            : undefined,
        recordPushObserved: (headCommit) => execution.recordEffect("push", { headCommit }),
        recordObserved: (observedUrl) =>
          execution.recordEffect("pull_request", { url: observedUrl }),
      });
    } catch (observationError) {
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication is unconfirmed; restore read access to the original target and retry recovery. Recorded effects are retained.",
        { cause: observationError },
      );
    }
    if (url) {
      return projectGitHubPublicationResult(
        await execution.complete({
          requestId: row.request_id,
          status: "published",
          url,
          repository: row.repository,
          branch: row.branch,
          headCommit: row.head_commit,
        }),
      );
    }
  }
  return projectGitHubPublicationResult(
    await execution.complete({
      requestId: row.request_id,
      status: "failed",
      ...error.failure,
      message: error.message,
    }),
  );
}

export function createRepositoryGitHubPublicationRecovery(params: {
  placements: WorkerSessionPlacementStore;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  isExecuting: (requestId: string) => boolean;
  assertCurrent: () => void;
  execute: (
    row: RepositoryGitHubPublicationRow,
    assertCustody: () => void,
  ) => Promise<SessionGitHubPublicationResult>;
}) {
  const { placements } = params;
  return {
    async prepareClaimWorkspace(claim: WorkerSessionTurnClaim): Promise<void> {
      const assertCurrent = () => {
        if (!placements.validateWorkspaceResultClaim(claim)) {
          throw new Error("GitHub publication lost its workspace result claim.");
        }
      };
      const pending = await listRepositoryGitHubPublicationsAsync({
        sessionId: claim.sessionId,
        ownerProfileId: null,
        pending: true,
      });
      for (const row of pending.filter(
        (candidate) =>
          !candidate.checkpoint_ref &&
          (candidate.claim_id === null ||
            matchesRepositoryGitHubPublicationClaim(candidate, claim)),
      )) {
        try {
          await placements.prepareWorkspaceResultClaim(claim);
          const requester = await restoreGitHubPublicationRequester(
            row.requester_authority_json,
            { sessionKey: row.session_key, agentId: row.agent_id },
            params.getCommittedRuntimeConfig,
          );
          try {
            const assertPreparation = () => {
              params.assertCurrent();
              assertCurrent();
              requester.assertCurrent();
            };
            const authority: GitHubPublicationTransitionAuthority = {
              assertAction() {
                params.assertCurrent();
                assertCurrent();
                requester.signal.throwIfAborted();
              },
              assertCustody() {
                params.assertCurrent();
                assertCurrent();
              },
              prepareSource: () =>
                requester.prepareSource({
                  agentId: row.agent_id,
                  sessionKey: row.session_key,
                  sessionId: row.session_id,
                  lifecycleRevision: row.session_lifecycle_revision,
                  repositoryWorkspaceId: row.workspace_id,
                  repositoryBranch: row.branch,
                }),
            };
            await captureCheckpoint(
              row,
              assertPreparation,
              async (facts, prepared) => {
                if (!prepared.authority) {
                  throw new Error("GitHub publication checkpoint requires worker authority.");
                }
                await bindRepositoryGitHubPublicationCheckpointAsync(
                  row,
                  facts,
                  prepared.authority,
                );
              },
              authority,
            );
          } finally {
            requester.release();
          }
        } catch (error) {
          if (!(error instanceof GitHubPublicationRequesterUnavailableError)) {
            throw error;
          }
          // The accepted-result processor settles this request under its own
          // exclusion; a closed requester must not block other checkpoint owners.
        }
      }
    },
    /** @deprecated Use deferClaimPreparationAsync; removed in the next Plugin SDK major. */
    deferClaimPreparation(claim: WorkerSessionTurnClaim) {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "deferClaimPreparation",
        replacement: "deferClaimPreparationAsync",
      });
      deferRepositoryGitHubPublicationClaims(
        listRepositoryGitHubPublications({
          sessionId: claim.sessionId,
          ownerProfileId: null,
          pending: true,
        })
          .filter((row) => matchesRepositoryGitHubPublicationClaim(row, claim))
          .map((row) => row.request_id),
      );
    },
    async resumeSessionRequests(): Promise<void> {
      const failures: Error[] = [];
      const rows = await listRepositoryGitHubPublicationsAsync({
        ownerProfileId: null,
        pending: true,
      });
      const currentPlacements = await placements.getManyAsync(rows.map((row) => row.session_id));
      for (let row of rows) {
        try {
          if (
            currentPlacements.get(row.session_id)?.turnClaim ||
            params.isExecuting(row.request_id)
          ) {
            continue;
          }
          await placements.withRepositoryWorkspaceReservation(
            { sessionId: row.session_id, sessionKey: row.session_key, agentId: row.agent_id },
            async (assertCurrent) => {
              row = await requireRepositoryGitHubPublicationInWorker(row.request_id);
              if (terminalRepositoryGitHubPublication(row)) {
                return;
              }
              // The execution holds this same exclusion until its awaited effect
              // observation is recorded. Only then may recovery retire its authority.
              const workspaceId = row.workspace_id;
              const preparedOwner = await getSessionRepositoryWorkspaceStore().prepare(workspaceId);
              row = await requireRepositoryGitHubPublicationInWorker(row.request_id);
              assertCurrent();
              if (terminalRepositoryGitHubPublication(row)) {
                return;
              }
              if (row.workspace_id !== workspaceId) {
                throw new GitHubPublicationRecoveryPendingError(
                  "GitHub publication repository source changed during recovery.",
                );
              }
              const owner = resolveReceiptOwner(row, preparedOwner);
              if (!owner) {
                // Keep the reservation through settlement; retirement needs only owner custody.
                await failStaleRepositoryGitHubPublicationAsync(row, params.assertCurrent);
                return;
              }
              await params.execute(row, assertCurrent);
            },
          );
        } catch (error) {
          if (
            error instanceof SessionWorkspaceReservationBusyError ||
            (error instanceof OpenClawStateLeaseAcquisitionError && error.outcome.kind === "held")
          ) {
            continue;
          }
          failures.push(
            new Error(`Publication ${row.request_id}: ${formatErrorMessage(error)}`, {
              cause: error,
            }),
          );
        }
      }
      // One temporarily blocked session must not starve unrelated receipts; hard
      // failures still reach the runtime's warning after every eligible owner runs.
      if (failures.length > 0) {
        throw new AggregateError(failures, failures.map((error) => error.message).join("; "));
      }
    },
    /** @deprecated Use deferOrphanedRequestsAsync; removed in the next Plugin SDK major. */
    deferOrphanedRequests(): void {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "deferOrphanedRequests",
        replacement: "deferOrphanedRequestsAsync",
      });
      throw new Error(
        "Await deferOrphanedRequestsAsync; synchronous placement reads are no longer supported.",
      );
    },
    async deferOrphanedRequestsAsync(): Promise<void> {
      const pending = await listRepositoryGitHubPublicationsAsync({
        ownerProfileId: null,
        pending: true,
      });
      if (pending.length === 0) {
        return;
      }
      await deferRepositoryGitHubPublicationClaimsAsync({ kind: "orphaned" }, params.assertCurrent);
    },
  };
}

async function readRepositoryGitHubPublicationInWorker(
  requestId: string,
): Promise<RepositoryGitHubPublicationRow | undefined> {
  const result = await readGitHubPublicationInWorker({
    type: "githubPublications.repositoryRead",
    input: { requestId },
  });
  if (result?.type !== "githubPublications.repositoryRead") {
    throw new Error("GitHub repository publication receipt is unavailable.");
  }
  return result.row;
}

async function requireRepositoryGitHubPublicationInWorker(
  requestId: string,
): Promise<RepositoryGitHubPublicationRow> {
  const row = await readRepositoryGitHubPublicationInWorker(requestId);
  if (!row) {
    throw new Error("GitHub publication request no longer exists.");
  }
  return row;
}

async function readKnownRepositoryGitHubPublicationPullRequestUrls(
  row: RepositoryGitHubPublicationRow,
): Promise<string[]> {
  const {
    workspace_id,
    push_repository,
    repository,
    branch,
    base_branch,
    identity_account_id,
    pull_request_url,
  } = row;
  const result = await executeExistingOpenClawStateRead(
    {},
    {
      type: "githubRepository.knownPullRequestUrls",
      input: {
        workspace_id,
        push_repository,
        repository,
        branch,
        base_branch,
        identity_account_id,
        pull_request_url,
      },
    },
    { current: true },
  );
  if (!result?.ok || result.type !== "githubRepository.knownPullRequestUrls") {
    throw new Error("GitHub repository publication receipt history is unavailable.");
  }
  return result.urls;
}
