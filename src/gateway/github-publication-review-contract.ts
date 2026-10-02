import { z } from "zod";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { GitHubPublicationRequesterSnapshot } from "../state/github-publication-requester.js";
import { GitHubPublicationWorkspaceChangedError } from "./github-publication-failure.js";

const objectId = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
const boundedId = z.string().min(1).max(256);
const account = z.strictObject({ accountId: z.number().int().positive(), login: boundedId });

/** Durable review contains source bytes; it cannot outlive an incognito conversation. */
export function assertDurableGitHubPublicationReview(sessionKey: string): void {
  if (isIncognitoSessionKey(sessionKey)) {
    throw new Error(
      "Publication review is unavailable in Incognito. Start a regular conversation and prepare its repository changes before requesting review.",
    );
  }
}

/** Review bytes and authority facts have one durable owner; none are client-selected targets. */
export const gitHubPublicationReviewCandidateSchema = z.strictObject({
  workspace: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("worktree"),
      id: boundedId,
      repositoryFingerprint: boundedId,
    }),
    z.strictObject({
      kind: z.literal("repository"),
      id: boundedId,
      revision: z.number().int().nonnegative(),
      checkpointRef: boundedId,
      checkpointDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    }),
  ]),
  selection: z.discriminatedUnion("source", [
    z.strictObject({ source: z.literal("shared") }),
    z.strictObject({ source: z.literal("personal"), generation: z.uuid(), account }),
  ]),
  publisher: z.strictObject({
    source: z.enum(["system-detected", "system-configured", "agent-override", "personal"]),
    profileId: boundedId.nullable(),
    ...account.shape,
  }),
  target: z.strictObject({
    pushRepository: boundedId,
    repository: boundedId,
    pushRepositoryId: z.number().int().positive(),
    repositoryId: z.number().int().positive(),
    branch: boundedId,
    baseBranch: boundedId,
    baseCommit: objectId,
    remoteHeadCommit: objectId.nullable(),
  }),
  snapshot: z.strictObject({
    sourceHeadCommit: objectId,
    sourceIndexTree: objectId,
    workspaceTree: objectId,
  }),
  title: z.string().min(1).max(256).nullable(),
  body: z.string().min(1).max(8192).nullable(),
  diff: z.string().max(256 * 1024),
});

export type GitHubPublicationReviewCandidate = z.infer<
  typeof gitHubPublicationReviewCandidateSchema
>;

export type PreparedGitHubPublicationReview = Readonly<{
  id: string;
  digest: string;
  candidate: GitHubPublicationReviewCandidate;
  requester: GitHubPublicationRequesterSnapshot;
  assertCurrent: () => void;
  assertBoundRequest: (requestId: string) => void;
  retain: () => {
    review: PreparedGitHubPublicationReview;
    signal: AbortSignal;
    release: () => void;
  };
}>;

export function assertGitHubPublicationReviewIdentity(
  review: PreparedGitHubPublicationReview,
  identity: PreparedGitHubPublicationIdentity,
): void {
  review.assertCurrent();
  const selected = review.candidate.publisher;
  if (
    selected.source !== identity.source ||
    selected.profileId !== (identity.profileId ?? null) ||
    selected.accountId !== identity.account.accountId ||
    selected.login.toLowerCase() !== identity.account.login.toLowerCase()
  ) {
    throw new GitHubPublicationWorkspaceChangedError(
      "The reviewed publishing account changed. Prepare a new candidate.",
    );
  }
}

export function assertGitHubPublicationReviewSnapshot(
  review: PreparedGitHubPublicationReview,
  snapshot: GitHubPublicationReviewCandidate["snapshot"],
): void {
  review.assertCurrent();
  const accepted = review.candidate.snapshot;
  if (
    accepted.sourceHeadCommit !== snapshot.sourceHeadCommit ||
    accepted.sourceIndexTree !== snapshot.sourceIndexTree ||
    accepted.workspaceTree !== snapshot.workspaceTree
  ) {
    throw new GitHubPublicationWorkspaceChangedError(
      "The reviewed source changed. Prepare a new candidate.",
    );
  }
}
