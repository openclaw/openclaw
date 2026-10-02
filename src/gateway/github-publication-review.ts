import type {
  GitHubPublicationReviewReference,
  SessionGitHubPublicationResult,
  SessionGitHubReviewDiffResult,
  SessionGitHubReviewResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import {
  decodeGitHubPublicationRequester,
  matchesGitHubPublicationRequester,
} from "../state/github-publication-requester.js";
import {
  prepareGitHubPublicationWorkspaceOwner,
  type PublicationSessionIdentity,
} from "./github-publication-availability.js";
import { GitHubPublicationWorkspaceChangedError } from "./github-publication-failure.js";
import type { GitHubPublicationRequester } from "./github-publication-requester.js";
import {
  assertDurableGitHubPublicationReview,
  type PreparedGitHubPublicationReview,
} from "./github-publication-review-contract.js";
import {
  markGitHubPublicationReviewStale,
  prepareGitHubPublicationReviewObservation,
  readGitHubPublicationReviewCandidate,
  type GitHubPublicationReviewRow,
} from "./github-publication-review-store.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

export function assertGitHubPublicationReviewSession(
  row: GitHubPublicationReviewRow,
  session: PublicationSessionIdentity,
): void {
  if (
    row.session_id !== session.sessionId ||
    row.session_key !== session.sessionKey ||
    row.agent_id !== session.agentId ||
    row.lifecycle_revision !== (session.lifecycleRevision ?? null)
  ) {
    throw new Error("The publication review no longer belongs to this session generation.");
  }
}

export function projectGitHubPublicationReview(
  row: GitHubPublicationReviewRow,
  publication?: SessionGitHubPublicationResult,
): SessionGitHubReviewResult {
  const candidate = row.candidate_json ? readGitHubPublicationReviewCandidate(row) : undefined;
  const status =
    publication?.status === "failed" &&
    (publication.code === "workspace_changed" || publication.code === "session_changed")
      ? "stale"
      : publication?.status === "published" || publication?.status === "failed"
        ? publication.status
        : row.stale_reason
          ? "stale"
          : row.publication_request_id
            ? "needs_confirmation"
            : candidate
              ? "ready"
              : "requested";
  return {
    reviewId: row.review_id,
    requestedReviewId: row.requested_review_id,
    digest: row.candidate_digest,
    status,
    message:
      row.stale_reason ??
      (status === "requested"
        ? "Review requested. A maintainer can review and publish these changes in this conversation."
        : status === "ready"
          ? "Review the complete diff and target, then confirm this exact candidate."
          : status === "needs_confirmation"
            ? "This candidate needs fresh maintainer confirmation before any further publication."
            : status === "published"
              ? "The reviewed candidate was published."
              : status === "stale"
                ? "The reviewed source or target changed. Prepare and review a new candidate."
                : "Publication failed; inspect the recorded result."),
    diffLength: candidate?.diff.length ?? 0,
    ...(candidate
      ? {
          target: {
            pushRepository: candidate.target.pushRepository,
            repository: candidate.target.repository,
            branch: candidate.target.branch,
            baseBranch: candidate.target.baseBranch,
            baseCommit: candidate.target.baseCommit,
            remoteHeadCommit: candidate.target.remoteHeadCommit,
            ...candidate.snapshot,
          },
          publisher: {
            source: candidate.publisher.source,
            accountId: candidate.publisher.accountId,
            login: candidate.publisher.login,
          },
          title: candidate.title,
          body: candidate.body,
        }
      : {}),
    ...(publication ? { publication } : {}),
  };
}

/** Diff pages are explicit review data, never automatically injected instructions. */
export function readGitHubPublicationReviewDiff(
  row: GitHubPublicationReviewRow,
  reference: GitHubPublicationReviewReference,
  offset: number,
): SessionGitHubReviewDiffResult {
  if (row.review_id !== reference.reviewId || row.candidate_digest !== reference.digest) {
    throw new Error("The review candidate changed; select it again.");
  }
  const candidate = readGitHubPublicationReviewCandidate(row);
  if (offset > candidate.diff.length) {
    throw new Error("The review diff page is outside this candidate.");
  }
  const text = candidate.diff.slice(offset, offset + 4096);
  const end = offset + text.length;
  return {
    reviewId: reference.reviewId,
    digest: reference.digest,
    offset,
    nextOffset: end < candidate.diff.length ? end : null,
    totalCharacters: candidate.diff.length,
    complete: end === candidate.diff.length,
    text,
  };
}

export function publicationNeedsReviewConfirmation(
  result: SessionGitHubPublicationResult,
): SessionGitHubPublicationResult {
  if (result.status === "published" || result.status === "failed") {
    return result;
  }
  return {
    requestId: result.requestId,
    publisher: result.publisher,
    effect: result.effect,
    status: "needs_confirmation",
    message:
      "Review this candidate and confirm it from a fresh maintainer action to continue publication.",
  };
}

export function requireGitHubPublicationReview(input: {
  sandbox?: string;
  requester?: GitHubPublicationRequester;
  review?: PreparedGitHubPublicationReview;
}): void {
  input.requester?.assertCurrent();
  input.review?.assertCurrent();
  if (!input.review && (input.sandbox === "required" || input.requester?.requiresReview)) {
    throw new Error(
      "This session requires a reviewed publication candidate. Prepare and review its exact diff, then confirm the candidate from a maintainer action.",
    );
  }
}

/** An inert SQLite row is review history. Only this live caller closure authorizes an effect. */
export async function prepareGitHubPublicationReviewConfirmation(
  reference: GitHubPublicationReviewReference,
  session: PublicationSessionIdentity,
  requester: GitHubPublicationRequester,
): Promise<PreparedGitHubPublicationReview> {
  assertDurableGitHubPublicationReview(session.sessionKey);
  requester.assertCurrent();
  const observation = await prepareGitHubPublicationReviewObservation(reference.reviewId);
  requester.assertCurrent();
  const row = observation.row;
  if (!row || row.candidate_digest !== reference.digest || row.stale_reason) {
    throw new Error("This publication candidate is stale or unavailable. Prepare a new review.");
  }
  assertGitHubPublicationReviewSession(row, session);
  const original = decodeGitHubPublicationRequester(row.requester_authority_json);
  if (!original || !matchesGitHubPublicationRequester(original, requester.snapshot)) {
    throw new Error(
      "Confirm the candidate from the original maintainer's current authority, or prepare a new review.",
    );
  }
  const candidate = readGitHubPublicationReviewCandidate(row);
  const currentWorkspace = await prepareGitHubPublicationWorkspaceOwner(session);
  requester.assertCurrent();
  const assertWorkspace = (acceptedOwnTurn = false) => {
    const current = currentWorkspace();
    const selected = candidate.workspace;
    if (
      current.kind !== selected.kind ||
      (current.kind === "worktree" &&
        selected.kind === "worktree" &&
        (current.worktree.id !== selected.id ||
          current.worktree.repoFingerprint !== selected.repositoryFingerprint ||
          current.worktree.branch !== candidate.target.branch)) ||
      (current.kind === "repository" &&
        selected.kind === "repository" &&
        (current.workspace.workspaceId !== selected.id ||
          current.workspace.branch !== candidate.target.branch ||
          (!acceptedOwnTurn &&
            (current.workspace.revision !== selected.revision ||
              current.workspace.checkpointRef !== selected.checkpointRef))))
    ) {
      throw new GitHubPublicationWorkspaceChangedError(
        "The reviewed workspace changed. Prepare a new candidate.",
      );
    }
  };
  try {
    assertWorkspace();
  } catch (error) {
    if (error instanceof GitHubPublicationWorkspaceChangedError) {
      await markGitHubPublicationReviewStale(
        row,
        "The reviewed workspace changed. Prepare a new candidate.",
      );
    }
    throw error;
  }
  const create = (
    authority: GitHubPublicationRequester,
    acceptedOwnTurn = false,
  ): PreparedGitHubPublicationReview => {
    const assertCurrent = () => {
      authority.assertCurrent();
      const latest = observation.current();
      if (!latest || latest.candidate_digest !== row.candidate_digest || latest.stale_reason) {
        throw new GitHubPublicationWorkspaceChangedError(
          "The reviewed candidate is no longer current.",
        );
      }
      assertWorkspace(acceptedOwnTurn);
      authority.assertCurrent();
    };
    return Object.freeze<PreparedGitHubPublicationReview>({
      id: row.review_id,
      digest: reference.digest,
      candidate,
      requester: authority.snapshot,
      assertCurrent,
      assertBoundRequest(requestId) {
        assertCurrent();
        if (observation.current()?.publication_request_id !== requestId) {
          throw new Error("Publication confirmation is not bound to this exact request.");
        }
      },
      retain: () => {
        assertCurrent();
        if (!authority.retainForReview) {
          throw new Error("A deferred review requires a live original maintainer source.");
        }
        const held = authority.retainForReview();
        // Only the coordinator's exact accepted-claim hold may advance checkpoint
        // metadata. A direct confirmation remains pinned across reservation waits.
        return { ...held, review: create(held.requester, true) };
      },
    });
  };
  const prepared = create(requester);
  prepared.assertCurrent();
  return prepared;
}

/** This map owns only confirmed publication effects, never a run or a background task. */
export function createGitHubPublicationReviewHolds(placements: WorkerSessionPlacementStore) {
  const active = new Map<
    string,
    {
      claim: WorkerSessionTurnClaim;
      review: PreparedGitHubPublicationReview;
      release: () => void;
    }
  >();
  const release = (requestId: string) => {
    const held = active.get(requestId);
    active.delete(requestId);
    held?.release();
  };
  const sameClaim = (a: WorkerSessionTurnClaim, b: WorkerSessionTurnClaim) =>
    a.sessionId === b.sessionId &&
    a.claimId === b.claimId &&
    a.runId === b.runId &&
    a.placementGeneration === b.placementGeneration &&
    a.owner.kind === b.owner.kind &&
    a.owner.environmentId === b.owner.environmentId &&
    a.owner.ownerEpoch === b.owner.ownerEpoch;
  const unregister = placements.registerTurnClaimClosedHandler((claim) => {
    for (const [id, held] of active) {
      if (sameClaim(held.claim, claim)) {
        release(id);
      }
    }
  });
  const drain = getGatewayRestartDrainSignal();
  drain.addEventListener(
    "abort",
    () => {
      unregister();
      for (const id of active.keys()) {
        release(id);
      }
    },
    { once: true },
  );
  return {
    release,
    retain(
      requestId: string,
      review: PreparedGitHubPublicationReview,
      claim: WorkerSessionTurnClaim,
    ) {
      review.assertCurrent();
      drain.throwIfAborted();
      review.assertBoundRequest(requestId);
      if (!placements.validateTurnClaim(claim)) {
        throw new Error("Publication confirmation could not transfer to its exact accepted turn.");
      }
      const held = review.retain();
      release(requestId);
      active.set(requestId, {
        claim,
        review: held.review,
        release: () => {
          held.signal.removeEventListener("abort", revoked);
          held.release();
        },
      });
      const revoked = () => release(requestId);
      held.signal.addEventListener("abort", revoked, { once: true });
      if (held.signal.aborted) {
        revoked();
      }
    },
    current(requestId: string, claim: WorkerSessionTurnClaim) {
      const held = active.get(requestId);
      if (!held || !sameClaim(held.claim, claim)) {
        return undefined;
      }
      try {
        drain.throwIfAborted();
        if (!placements.validateWorkspaceResultClaim(claim)) {
          throw new Error("Publication turn closed.");
        }
        held.review.assertCurrent();
        return held.review;
      } catch {
        release(requestId);
        return undefined;
      }
    },
  };
}
