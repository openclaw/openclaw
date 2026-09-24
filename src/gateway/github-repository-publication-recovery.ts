import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import { decodeGitHubPublicationRequester } from "../state/github-publication-requester.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { OpenClawStateLeaseAcquisitionError } from "../state/openclaw-state-lease-error.js";
import { exactClaimForPlacement } from "./github-publication-coordinator-methods.js";
import { createGitHubPublicationExecutionIdentity } from "./github-publication-execution-identity.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import { reconcileGitHubPublicationPullRequest } from "./github-publication-pull-requests.js";
import { restoreGitHubPublicationRequester } from "./github-publication-requester.js";
import { projectGitHubPublicationResult } from "./github-publication-store.js";
import {
  bindRepositoryGitHubPublicationCheckpoint,
  deferRepositoryGitHubPublicationClaims,
  failStaleRepositoryGitHubPublication,
  listRepositoryGitHubPublications,
  requireRepositoryGitHubPublication,
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
import { SessionWorkspaceReservationBusyError } from "./worker-environments/placement-workspace-reservation.js";

export async function settleDeniedRepositoryGitHubPublication(params: {
  execution: RepositoryGitHubPublicationExecution;
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
    const { assertCurrent, refreshIdentity } = createGitHubPublicationExecutionIdentity({
      row,
      validateAuthority: () => {
        assertCustody();
        return execution.ownsExecution();
      },
      assertWorkspace: () => {
        assertReceiptOwner(row);
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
        execution.complete({
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
    execution.complete({
      requestId: row.request_id,
      status: "failed",
      ...error.failure,
      message: error.message,
    }),
  );
}

export function matchesRepositoryGitHubPublicationClaim(
  row: RepositoryGitHubPublicationRow,
  claim: WorkerSessionTurnClaim,
): boolean {
  return (
    row.environment_id !== null &&
    row.owner_epoch !== null &&
    row.session_id === claim.sessionId &&
    row.claim_id === claim.claimId &&
    row.run_id === claim.runId &&
    row.placement_generation === claim.placementGeneration &&
    row.environment_id === (claim.owner.environmentId ?? null) &&
    row.owner_epoch === (claim.owner.ownerEpoch ?? null)
  );
}

export function createRepositoryGitHubPublicationRecovery(params: {
  placements: WorkerSessionPlacementStore;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  isExecuting: (requestId: string) => boolean;
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
      const pending = listRepositoryGitHubPublications({
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
          const requester = await restoreGitHubPublicationRequester(
            row.requester_authority_json,
            { sessionKey: row.session_key, agentId: row.agent_id },
            params.getCommittedRuntimeConfig,
          );
          try {
            const assertPreparation = () => {
              assertCurrent();
              requester.assertCurrent();
            };
            await captureCheckpoint(row, assertPreparation, async (facts) => {
              bindRepositoryGitHubPublicationCheckpoint(row, facts, assertPreparation);
            });
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
    deferClaimPreparation(claim: WorkerSessionTurnClaim) {
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
      for (let row of listRepositoryGitHubPublications({ ownerProfileId: null, pending: true })) {
        try {
          if (placements.get(row.session_id)?.turnClaim || params.isExecuting(row.request_id)) {
            continue;
          }
          await placements.withRepositoryWorkspaceReservation(
            { sessionId: row.session_id, sessionKey: row.session_key, agentId: row.agent_id },
            async (assertCurrent) => {
              row = requireRepositoryGitHubPublication(row.request_id);
              if (terminalRepositoryGitHubPublication(row)) {
                return;
              }
              // The execution holds this same exclusion until its awaited effect
              // observation is recorded. Only then may recovery retire its authority.
              const owner = resolveReceiptOwner(row);
              if (!owner) {
                failStaleRepositoryGitHubPublication(row, () => Boolean(resolveReceiptOwner(row)));
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
    deferOrphanedRequests(): void {
      const pending = placements.listPendingWorkspaceResults();
      deferRepositoryGitHubPublicationClaims(
        listRepositoryGitHubPublications({ ownerProfileId: null, pending: true })
          .filter((row) => {
            if (!row.claim_id) {
              return false;
            }
            const placement = placements.get(row.session_id);
            const claim = placement ? exactClaimForPlacement(placement) : undefined;
            return (
              !(claim && matchesRepositoryGitHubPublicationClaim(row, claim)) &&
              !pending.some(
                (result) =>
                  result.sessionId === row.session_id &&
                  result.claimId === row.claim_id &&
                  result.runId === row.run_id,
              )
            );
          })
          .map((row) => row.request_id),
      );
    },
  };
}

async function readRepositoryGitHubPublicationInWorker(
  requestId: string,
): Promise<RepositoryGitHubPublicationRow | undefined> {
  const result = await executeExistingOpenClawStateRead(
    {},
    { type: "githubRepository.request", requestId },
    { current: true },
  );
  if (!result?.ok || result.type !== "githubRepository.request") {
    throw new Error("GitHub repository publication receipt is unavailable.");
  }
  return result.row;
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
