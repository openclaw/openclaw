import fs from "node:fs/promises";
import path from "node:path";
import type { SessionGitHubPublishParams } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { acquireWorktreeRunLease } from "../agents/worktrees/run-lease.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  prepareGitHubPublicationWorkspaceOwner,
  sameGitHubPublicationWorkspace,
  type PublicationSessionIdentity,
} from "./github-publication-availability.js";
import { githubPublicationBaseFetchArgs } from "./github-publication-base.js";
import {
  captureGitHubPublicationWorkspaceSnapshot,
  createGitHubPublicationCommandRunner,
} from "./github-publication-git-transport.js";
import {
  assertDurableGitHubPublicationReview,
  type GitHubPublicationReviewCandidate,
} from "./github-publication-review-contract.js";
import { readGitHubPublicationReviewTarget } from "./github-publication-review-target.js";
import { prepareGitHubPublicationTarget } from "./github-publication-target.js";
import { prepareRepositoryGitHubPublicationTarget } from "./github-repository-publication-executor.js";
import {
  readGitHubRepositoryPublicationBlob,
  readGitHubRepositoryPublicationMetadata,
  type GitHubRepositoryPublicationSnapshot,
} from "./github-repository-publication-snapshot.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";
import { prepareRepositoryWorkerReadWorkspace } from "./worker-environments/repository-git-pack.js";
import { withSessionRepositoryCheckpoint } from "./worker-environments/session-repository-checkpoints.js";

const MAX_REVIEW_DIFF_BYTES = 256 * 1024;

async function reviewDiff(input: {
  cwd: string;
  target: GitHubPublicationReviewCandidate["target"];
  tree: string;
  identity: PreparedGitHubPublicationIdentity;
  assertCurrent: () => void;
}) {
  const { require: command, run } = createGitHubPublicationCommandRunner(input.assertCurrent);
  await command(githubPublicationBaseFetchArgs(input.target.repository, input.target.baseCommit), {
    cwd: input.cwd,
    env: {
      ...input.identity.env,
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_CONFIG_SYSTEM: gitNullConfigPath(),
    },
  });
  const result = await run(
    [
      "git",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--binary",
      input.target.baseCommit,
      input.tree,
      "--",
    ],
    { cwd: input.cwd, maxOutputBytes: MAX_REVIEW_DIFF_BYTES },
  );
  if (result.code !== 0 || result.termination === "output-limit") {
    throw new Error(
      "The complete candidate diff is unavailable or exceeds the review limit. Split the changes and prepare a new review.",
    );
  }
  const text = result.stdout.toString("utf8");
  if (!Buffer.from(text).equals(result.stdout)) {
    throw new Error(
      "The candidate diff cannot be displayed safely; review the repository locally.",
    );
  }
  return text;
}

/** Rebuild only verified Git objects in disposable Gateway scratch, never the live worker. */
async function repositoryReviewDiff(input: {
  url: string;
  snapshot: GitHubRepositoryPublicationSnapshot;
  snapshotRoot: string;
  target: GitHubPublicationReviewCandidate["target"];
  identity: PreparedGitHubPublicationIdentity;
  assertCurrent: () => void;
  signal: AbortSignal;
}) {
  const temporaryRoot = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "publication-review-"),
  );
  try {
    const cwd = await prepareRepositoryWorkerReadWorkspace({
      url: input.url,
      baseCommit: input.snapshot.baseCommit,
      token: input.identity.env.GH_TOKEN ?? "",
      temporaryRoot,
      assertCurrent: input.assertCurrent,
      signal: input.signal,
    });
    const { require: command } = createGitHubPublicationCommandRunner(input.assertCurrent);
    await command(["git", "read-tree", input.snapshot.baseTree], { cwd });
    for (const entry of input.snapshot.entries) {
      if (entry.sha && entry.mode !== "160000") {
        const bytes = await readGitHubRepositoryPublicationBlob(input.snapshotRoot, entry.sha);
        input.assertCurrent();
        if (
          (await command(["git", "hash-object", "-w", "--stdin"], { cwd, input: bytes })) !==
          entry.sha
        ) {
          throw new Error("The accepted publication blob changed during review.");
        }
      }
    }
    const index = input.snapshot.entries
      .map(
        (entry) =>
          `${entry.sha ? entry.mode : "0"} ${entry.sha ?? "0".repeat(40)}\t${entry.path}\0`,
      )
      .join("");
    await command(["git", "update-index", "-z", "--index-info"], { cwd, input: index });
    if ((await command(["git", "write-tree"], { cwd })) !== input.snapshot.workspaceTree) {
      throw new Error("The accepted checkpoint cannot reproduce its reviewed tree.");
    }
    return await reviewDiff({ ...input, cwd, tree: input.snapshot.workspaceTree });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function captureGitHubPublicationReview(input: {
  placements: WorkerSessionPlacementStore;
  session: PublicationSessionIdentity;
  request: Pick<SessionGitHubPublishParams, "title" | "body" | "selection">;
  prepareIdentity: (assertCurrent: () => void) => Promise<PreparedGitHubPublicationIdentity>;
  assertCurrent: () => void;
  signal: AbortSignal;
  claim?: WorkerSessionTurnClaim;
}): Promise<GitHubPublicationReviewCandidate> {
  assertDurableGitHubPublicationReview(input.session.sessionKey);
  input.assertCurrent();
  const current = await prepareGitHubPublicationWorkspaceOwner(input.session);
  input.assertCurrent();
  const initial = current();
  const reserve = <T>(run: (assertCurrent: () => void) => Promise<T>) =>
    input.claim
      ? input.placements.withWorkspaceExclusion(input.session.sessionId, run)
      : initial.kind === "repository"
        ? input.placements.withRepositoryWorkspaceReservation(input.session, run)
        : input.placements.withLocalWorkspaceReservation(input.session, run);
  return await reserve<GitHubPublicationReviewCandidate>(async (assertReservation) => {
    const assertCurrent = () => {
      input.signal.throwIfAborted();
      input.assertCurrent();
      assertReservation();
      if (
        input.claim &&
        (input.claim.sessionId !== input.session.sessionId ||
          !input.placements.validateTurnClaim(input.claim))
      ) {
        throw new Error("The maintainer's publication review turn is no longer current.");
      }
      if (!sameGitHubPublicationWorkspace(initial, current())) {
        throw new Error("The publication workspace changed during review.");
      }
    };
    const identity = await input.prepareIdentity(assertCurrent);
    assertCurrent();
    const common = {
      publisher: {
        source: identity.source,
        profileId: identity.profileId ?? null,
        accountId: identity.account.accountId,
        login: identity.account.login,
      },
      selection:
        input.request.selection?.source === "personal"
          ? {
              source: "personal" as const,
              generation: input.request.selection.generation,
              account: {
                accountId: input.request.selection.account.accountId,
                login: input.request.selection.account.login,
              },
            }
          : { source: "shared" as const },
      title: input.request.title ?? null,
      body: input.request.body ?? null,
    };
    if (initial.kind === "worktree") {
      // An exact own-turn review shares its deletion lease; it does not freeze tool writes.
      // Capture twice so asynchronous diff preparation cannot quietly review newer bytes.
      const lease = await acquireWorktreeRunLease(
        initial.worktree.id,
        input.claim ? undefined : { exclusive: true },
      );
      try {
        assertCurrent();
        const target = await readGitHubPublicationReviewTarget({
          target: await prepareGitHubPublicationTarget({
            worktree: initial.worktree,
            identity,
            assertCurrent,
          }),
          identity,
          assertCurrent,
        });
        const snapshot = await captureGitHubPublicationWorkspaceSnapshot({
          cwd: initial.worktree.path,
          assertCurrent,
        });
        const diff = await reviewDiff({
          cwd: initial.worktree.path,
          target,
          tree: snapshot.workspaceTree,
          identity,
          assertCurrent,
        });
        const after = await captureGitHubPublicationWorkspaceSnapshot({
          cwd: initial.worktree.path,
          assertCurrent,
        });
        if (
          after.sourceHeadCommit !== snapshot.sourceHeadCommit ||
          after.sourceIndexTree !== snapshot.sourceIndexTree ||
          after.workspaceTree !== snapshot.workspaceTree
        ) {
          throw new Error(
            "The workspace changed during review. Finish editing and prepare a new candidate.",
          );
        }
        assertCurrent();
        return {
          ...common,
          target,
          snapshot,
          diff,
          workspace: {
            kind: "worktree",
            id: initial.worktree.id,
            repositoryFingerprint: initial.worktree.repoFingerprint,
          },
        };
      } finally {
        await lease.release();
      }
    }
    const workspace = initial.workspace;
    if (!workspace.checkpointRef) {
      throw new Error("Finish the current turn and save a checkpoint before requesting review.");
    }
    const assertCheckpoint = () => {
      assertCurrent();
      const owner = current();
      if (
        owner.kind !== "repository" ||
        owner.workspace.revision !== workspace.revision ||
        owner.workspace.checkpointRef !== workspace.checkpointRef
      ) {
        throw new Error("The accepted repository checkpoint changed during review.");
      }
    };
    const target = await readGitHubPublicationReviewTarget({
      target: {
        ...(await prepareRepositoryGitHubPublicationTarget(workspace, identity, assertCheckpoint)),
        branch: workspace.branch,
      },
      identity,
      assertCurrent: assertCheckpoint,
    });
    return await withSessionRepositoryCheckpoint(
      {
        workspaceId: workspace.workspaceId,
        checkpointRef: workspace.checkpointRef,
        includePublication: true,
      },
      async (payload) => {
        assertCheckpoint();
        if (!payload.publicationStagingRoot || !payload.publicationDigest) {
          throw new Error(
            "The accepted publication snapshot is unavailable. Save a new checkpoint and request a new review.",
          );
        }
        const { snapshot } = await readGitHubRepositoryPublicationMetadata(
          payload.publicationStagingRoot,
          payload.publicationDigest,
        );
        assertCheckpoint();
        const diff = await repositoryReviewDiff({
          url: workspace.url,
          snapshot,
          snapshotRoot: payload.publicationStagingRoot,
          target,
          identity,
          assertCurrent: assertCheckpoint,
          signal: input.signal,
        });
        assertCheckpoint();
        return {
          ...common,
          target,
          diff,
          snapshot: {
            sourceHeadCommit: snapshot.baseCommit,
            sourceIndexTree: snapshot.baseTree,
            workspaceTree: snapshot.workspaceTree,
          },
          workspace: {
            kind: "repository",
            id: workspace.workspaceId,
            revision: workspace.revision,
            checkpointRef: workspace.checkpointRef!,
            checkpointDigest: payload.publicationDigest,
          },
        };
      },
    );
  });
}
