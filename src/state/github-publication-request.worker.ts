import { insertPersonalGitHubPublicationInDatabase } from "../gateway/github-personal-publication-store.worker.js";
import { captureGitHubPublicationChanges } from "../gateway/github-publication-events.js";
import {
  assertSharedGitHubPublicationClaimInDatabase,
  insertGitHubPublicationRequest,
} from "../gateway/github-publication-store.worker.js";
import { insertRepositoryGitHubPublicationInDatabase } from "../gateway/github-repository-publication-store.worker.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import type { RepositoryGitHubPublicationRow } from "./github-publication-read.types.js";
import { captureGitHubPublicationWorkerReceipt } from "./github-publication-receipts.js";
import type { GitHubPublicationSourcePredicate } from "./github-publication-source-contract.js";
import {
  assertGitHubPublicationWorktreeSource,
  assertGitHubPublicationConnectionAdmissionSource,
} from "./github-publication-source.kernel.js";
import type { GitHubPublicationSourceFacts } from "./github-publication-source.types.js";
import { assertGitHubPublicationWorkerSourceCurrent } from "./github-publication-source.worker.js";
import type {
  GitHubPublicationInsert,
  PublicationMutationReceipt,
  PublicationMutationResult,
} from "./github-publication-worker.types.js";
import type { PublicationWorkerOperations } from "./github-publication.worker-contract.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

function assertRepositoryClaim(
  row: RepositoryGitHubPublicationRow,
  placement: GitHubPublicationSourceFacts["placement"],
): void {
  if (row.claim_id === null) {
    return;
  }
  if (
    !placement ||
    placement.session_id !== row.session_id ||
    placement.agent_id !== row.agent_id ||
    placement.session_key !== row.session_key ||
    !["active", "draining", "local"].includes(placement.state) ||
    placement.turn_claim_id !== row.claim_id ||
    placement.turn_claim_run_id !== row.run_id ||
    placement.turn_claim_generation !== row.placement_generation ||
    (placement.turn_claim_owner !== "local" &&
      (placement.turn_claim_owner !== "worker" ||
        placement.environment_id !== row.environment_id ||
        placement.active_owner_epoch !== row.owner_epoch ||
        placement.turn_claim_owner_epoch !== row.owner_epoch))
  ) {
    throw new Error("GitHub publication requested turn claim changed.");
  }
}

function assertRequestedSource(
  input: GitHubPublicationInsert,
  source: GitHubPublicationSourcePredicate,
): void {
  const { selector } = source;
  const session =
    input.kind === "shared"
      ? {
          sessionId: input.input.sessionId,
          sessionKey: input.input.request.sessionKey,
          agentId: input.input.request.agentId,
          lifecycleRevision: input.input.lifecycleRevision,
        }
      : {
          sessionId: input.row.session_id,
          sessionKey: input.row.session_key,
          agentId: input.row.agent_id,
          lifecycleRevision:
            input.kind === "personal"
              ? input.lifecycleRevision
              : input.row.session_lifecycle_revision,
        };
  if (
    selector.sessionId !== session.sessionId ||
    selector.sessionKey !== session.sessionKey ||
    selector.agentId !== session.agentId ||
    selector.lifecycleRevision !== session.lifecycleRevision
  ) {
    throw new Error("GitHub publication requested session changed.");
  }
  if (input.kind === "shared") {
    assertGitHubPublicationWorktreeSource(source, input.input.worktree);
    const actor = input.input.requester.actor;
    if ((actor.kind === "operator" ? actor.profileId : undefined) !== selector.profileId) {
      throw new Error("GitHub publication requested actor changed.");
    }
    return;
  }
  const { row } = input;
  if (input.kind === "personal") {
    assertGitHubPublicationWorktreeSource(source, {
      id: input.row.worktree_id,
      repoFingerprint: input.row.repository_fingerprint,
      branch: row.branch,
    });
    // Record the verified account before execution rejects a changed login.
    assertGitHubPublicationConnectionAdmissionSource(source, input.row);
    return;
  }
  const workspace = source.expected.repositoryWorkspace;
  if (
    selector.repositoryWorkspaceId !== input.row.workspace_id ||
    workspace?.workspaceId !== input.row.workspace_id ||
    workspace.branch !== row.branch ||
    workspace.agentId !== row.agent_id ||
    workspace.sessionKey !== row.session_key
  ) {
    throw new Error("GitHub publication requested repository changed.");
  }
  if (input.row.owner_profile_id !== null) {
    if (input.row.connection_generation === null || input.row.identity_profile_id === null) {
      throw new Error("GitHub publication requested connection is unavailable.");
    }
    assertGitHubPublicationConnectionAdmissionSource(source, {
      ...input.row,
      owner_profile_id: input.row.owner_profile_id,
      connection_generation: input.row.connection_generation,
      identity_profile_id: input.row.identity_profile_id,
    });
  }
  assertRepositoryClaim(input.row, source.expected.placement);
}

export const publicationRequestOperations = {
  "githubPublications.insert": (
    input: PublicationWorkerOperations["githubPublications.insert"]["input"],
    { open },
  ): PublicationMutationReceipt => {
    const database = open();
    const assertCurrent = () => assertGitHubPublicationWorkerSourceCurrent(database.db);
    assertCurrent();
    assertRequestedSource(input, input.source);
    const write = (): PublicationMutationResult => {
      const identity = { operationId: input.operationId, operation: input.operation };
      switch (input.kind) {
        case "shared": {
          const claim = input.input.claim;
          if (claim) {
            if (claim.sessionId !== input.input.sessionId) {
              throw new Error("GitHub publication requested turn session changed.");
            }
            assertSharedGitHubPublicationClaimInDatabase(database.db, {
              claim,
              sessionKey: input.input.request.sessionKey,
              agentId: input.input.request.agentId,
            });
          }
          const row = insertGitHubPublicationRequest(database.db, {
            ...input.input,
            assertCurrent,
          });
          if (
            claim &&
            (row.claim_id !== claim.claimId ||
              row.run_id !== claim.runId ||
              row.placement_generation !== claim.placementGeneration ||
              row.environment_id !== (claim.owner.environmentId ?? null) ||
              row.owner_epoch !== (claim.owner.ownerEpoch ?? null))
          ) {
            throw new Error("GitHub publication idempotency key was reused.");
          }
          return {
            ...identity,
            kind: "shared",
            rows: [row],
          };
        }
        case "personal":
          return {
            ...identity,
            kind: "personal",
            rows: [
              insertPersonalGitHubPublicationInDatabase(
                database,
                input.row,
                input.lifecycleRevision,
                assertCurrent,
              ),
            ],
          };
        case "repository":
          return {
            ...identity,
            kind: "repository",
            rows: [insertRepositoryGitHubPublicationInDatabase(database, input.row, assertCurrent)],
          };
      }
      throw new Error("Unknown GitHub publication request kind.");
    };
    const receipt = captureGitHubPublicationWorkerReceipt(database.db, () => {
      const { value, changes } = captureGitHubPublicationChanges(write);
      return { ...value, changes };
    });
    assertCurrent();
    deferSqliteWorkerCommitReceipt(database.db, receipt);
    return receipt;
  },
} satisfies WorkerOperationHandlers;
