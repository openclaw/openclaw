import { randomUUID } from "node:crypto";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { GitHubPublicationRow as PublicationRow } from "../state/github-publication-read.types.js";
import {
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  repositoryPublicationPreflightCredential,
  repositoryPublicationPreflightActor,
  readGitHubPublicationWorktreeOwner,
} from "./github-publication-availability.js";
import type { GitHubPublicationClaimRequestV2 } from "./github-publication-coordinator-methods.js";
import {
  assertExpectedSharedGitHubPublisher,
  digestGitHubPublicationRequest as digestRequest,
  projectGitHubPublicationResult as publicationResult,
} from "./github-publication-receipt.js";
import { insertGitHubPublicationRequestAsync } from "./github-publication-request-async.js";
import { bindGitHubPublicationSourceLifetime } from "./github-publication-source.js";
import { readGitHubPublicationRequestAsync } from "./github-publication-store-async.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

function sameClaim(row: PublicationRow, claim: WorkerSessionTurnClaim): boolean {
  return (
    row.claim_id === claim.claimId &&
    row.run_id === claim.runId &&
    row.placement_generation === claim.placementGeneration &&
    row.environment_id === (claim.owner.environmentId ?? null) &&
    row.owner_epoch === (claim.owner.ownerEpoch ?? null)
  );
}

/** Prepare and record a turn-owned request before the execution coordinator can publish it. */
export function createGitHubPublicationClaimRequester(params: {
  placements: WorkerSessionPlacementStore;
  assertCurrent: () => void;
  signal: AbortSignal;
}) {
  const { assertCurrent, signal } = params;
  return async (
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
    using admitted = await readGitHubPublicationWorktreeOwner({
      allowExistingPullRequest: true,
      sessionId: request.claim.sessionId,
      sessionKey: request.sessionKey,
      agentId: request.agentId,
    });

    assertRequester();
    const identity = await prepareCurrentGitHubPublicationIdentity(
      request.agentId,
      repositoryPublicationPreflightActor(request.requester, request.sessionKey, assertRequester),
      repositoryPublicationPreflightCredential({
        agentId: request.agentId,
        sessionKey: request.sessionKey,
        sessionId: request.claim.sessionId,
        lifecycleRevision: admitted.loaded.entry?.lifecycleRevision ?? null,
        assertCurrent: assertRequester,
      }),
    );
    await using identityLifetime = {
      identity,
      [Symbol.asyncDispose]: async () => {
        await identity.revoke?.();
      },
    };
    assertRequester();
    const existing = await readGitHubPublicationRequestAsync({
      sessionId: request.claim.sessionId,
      idempotencyKey: request.idempotencyKey,
    });
    assertRequester();
    assertExpectedSharedGitHubPublisher(
      request.expectedPublisher,
      { source: identityLifetime.identity.source, ...identityLifetime.identity.account },
      {
        idempotencyKey: request.idempotencyKey,
        hasRequest: () => Boolean(existing),
      },
    );
    const worktreeOwner = admitted;
    const { worktree } = worktreeOwner;
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
      draft:
        existing && existing.draft == null && request.draft === undefined
          ? undefined
          : (request.draft ?? false),
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
        draft: request.draft ?? false,
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
        branch: worktreeOwner.publicationBranch,
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
}
