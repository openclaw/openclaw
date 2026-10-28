import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  assertGitLabPublicationActor,
  assertGitLabPublicationProject,
  createGitLabPublicationApi,
  parseGitLabMergeRequest,
  type GitLabPublicationCredentials,
  type GitLabPublicationIdentity,
  type GitLabPublicationTarget,
} from "./gitlab-publication-adapter.js";
import {
  observeGitLabPublicationHead,
  prepareGitLabPublicationGit,
  pushGitLabPublicationCommit,
} from "./gitlab-publication-git.js";

export type GitLabPublicationOutcome =
  | {
      status: "published";
      requestId: string;
      url: string;
      repository: string;
      branch: string;
      headCommit: string;
      publisherAccountId: number;
      mergeRequestAuthorId: number;
    }
  | {
      status: "failed";
      requestId: string;
      code:
        | "no_changes"
        | "workspace_changed"
        | "push_rejected"
        | "gitlab_rejected"
        | "identity_changed"
        | "unavailable";
      nextAction: string;
      message: string;
    };

/** The existing publication journal supplies this capability; the provider owns no receipt state. */
export type ForgePublicationExecution<Receipt> = {
  row: {
    requestId: string;
    branch: string;
    createdAtMs: number;
    sourceHeadCommit: string;
    sourceIndexTree: string;
    workspaceTree: string;
    previousHeadCommit: string | null;
    headCommit: string | null;
    lastEffect: "push" | "pull_request" | null;
    effectState: "dispatched" | "observed" | null;
  };
  ownsExecution(): boolean;
  updateHead(headCommit: string): Promise<unknown>;
  recordEffect(
    effect: "push" | "pull_request",
    observed?: { headCommit?: string; url?: string },
  ): Promise<void>;
  complete(result: GitLabPublicationOutcome): Promise<Receipt>;
  interrupt(): Promise<Receipt>;
};

class GitLabPublicationKnownFailure extends Error {
  constructor(
    message: string,
    readonly code: Extract<GitLabPublicationOutcome, { status: "failed" }>["code"],
    readonly nextAction: string,
  ) {
    super(message);
  }
}

const oid = /^[a-f0-9]{40}$/u;

/**
 * Publishes one already-admitted, accepted checkpoint. The caller retains source,
 * worktree, account, and journal custody across every awaited provider operation.
 */
export async function executeRepositoryGitLabPublication<Receipt>(params: {
  execution: ForgePublicationExecution<Receipt>;
  snapshot: { baseCommit: string; baseTree: string; workspaceTree: string };
  repositoryRoot: string;
  target: GitLabPublicationTarget;
  identity: GitLabPublicationIdentity;
  credentials: GitLabPublicationCredentials;
  assertCurrent: () => void;
  assertWorkflowChangesAllowed: () => void;
  /** Import the verified commit and CAS the native worktree branch/index under its owner lease. */
  commitLocally: (prepared: { headCommit: string; directory: string }) => Promise<void>;
  title: string;
  description: string;
  draft: boolean;
  bootstrapDraft?: boolean;
  parentCommit?: string;
  fetchImpl?: typeof fetch;
}): Promise<Receipt> {
  const { execution, snapshot, target, identity } = params;
  const row = execution.row;
  const parentCommit = params.parentCommit ?? row.previousHeadCommit ?? row.sourceHeadCommit;
  const assertAction = () => {
    params.assertCurrent();
    if (!execution.ownsExecution()) {
      throw new Error("GitLab publication execution custody changed.");
    }
  };
  let dispatched = row.lastEffect !== null;
  try {
    assertAction();
    if (
      snapshot.baseCommit !== row.sourceHeadCommit ||
      snapshot.baseTree !== row.sourceIndexTree ||
      snapshot.workspaceTree !== row.workspaceTree ||
      !oid.test(row.sourceHeadCommit) ||
      (row.previousHeadCommit !== null && !oid.test(row.previousHeadCommit)) ||
      !oid.test(parentCommit) ||
      (row.previousHeadCommit !== null && row.previousHeadCommit !== parentCommit) ||
      identity.issuer !== target.issuer ||
      (params.bootstrapDraft &&
        (!params.draft ||
          row.previousHeadCommit !== null ||
          snapshot.workspaceTree !== snapshot.baseTree)) ||
      /^\s*\/[a-z][a-z_]*(?:\s|$)/mu.test(params.description) ||
      !params.title.trim()
    ) {
      throw new GitLabPublicationKnownFailure(
        "GitLab publication accepted source or target changed.",
        "workspace_changed",
        "Review the accepted checkpoint and original GitLab target, then request publication again.",
      );
    }
    const api = createGitLabPublicationApi({
      target,
      credentials: params.credentials,
      assertCurrent: assertAction,
      ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
    });
    assertGitLabPublicationActor(await api.request({ method: "GET", path: "user" }), identity);
    assertGitLabPublicationProject(
      await api.request({ method: "GET", path: `projects/${target.projectId}` }),
      target,
    );
    const baseBranch = await api.request({
      method: "GET",
      path: `projects/${target.projectId}/repository/branches/${encodeURIComponent(target.baseBranch)}`,
    });
    if (!isRecord(baseBranch) || baseBranch.name !== target.baseBranch) {
      throw new Error("GitLab publication merge request base is unavailable.");
    }
    const sourceCommit = await api.request({
      method: "GET",
      path: `projects/${target.projectId}/repository/commits/${parentCommit}`,
    });
    if (!isRecord(sourceCommit) || sourceCommit.id !== parentCommit) {
      throw new Error("GitLab publication source commit is unavailable.");
    }
    const date = new Date(row.createdAtMs).toISOString();
    const marker = `<!-- openclaw-publication:${row.requestId} -->`;
    const message = `${params.title.trim()}\n\nOpenClaw-Publication: ${row.requestId}\n`;
    const git = await prepareGitLabPublicationGit({
      repositoryRoot: params.repositoryRoot,
      snapshot,
      parentCommit,
      message,
      author: { name: identity.name, email: identity.commitEmail, date },
      target,
      assertCurrent: assertAction,
    });
    try {
      if (
        (await git.run(["check-ref-format", "--branch", row.branch])) !== row.branch ||
        (await git.run(["check-ref-format", "--branch", target.baseBranch])) !==
          target.baseBranch ||
        row.branch === target.baseBranch
      ) {
        throw new GitLabPublicationKnownFailure(
          "GitLab publication branch is invalid.",
          "workspace_changed",
          "Use a session-owned topic branch distinct from the merge request base.",
        );
      }
      if (row.headCommit && row.headCommit !== git.headCommit) {
        throw new GitLabPublicationKnownFailure(
          "GitLab publication prepared commit changed.",
          "identity_changed",
          "Review the original account credit and accepted checkpoint before retrying.",
        );
      }
      const remoteHead = await observeGitLabPublicationHead({
        target,
        branch: row.branch,
        credentials: params.credentials,
        git,
        assertCurrent: assertAction,
      });
      if (remoteHead === git.headCommit) {
        // A push observation cannot erase an uncertain later MR creation.
        if (row.lastEffect !== "pull_request") {
          await execution.recordEffect("push", { headCommit: git.headCommit });
        }
      } else if (row.lastEffect === "push" && row.effectState === "dispatched") {
        throw new Error("The original GitLab push is unconfirmed.");
      } else if (remoteHead !== row.previousHeadCommit) {
        throw new GitLabPublicationKnownFailure(
          "GitLab publication branch moved.",
          "push_rejected",
          "Inspect the published branch and request a new publication from an accepted session branch. Do not rewrite its history.",
        );
      }
      if (row.previousHeadCommit) {
        await params.credentials.withToken(async (token) => {
          assertAction();
          await git.run(
            [
              "fetch",
              "--no-auto-maintenance",
              "--no-tags",
              "--no-write-fetch-head",
              "--recurse-submodules=no",
              "--",
              target.gitUrl,
              `refs/heads/${row.branch}:refs/openclaw-publication/observed`,
            ],
            token,
          );
        });
        const fetched = await git.run(["rev-parse", "refs/openclaw-publication/observed"]);
        if (fetched !== remoteHead && remoteHead !== git.headCommit) {
          throw new GitLabPublicationKnownFailure(
            "GitLab publication branch moved.",
            "push_rejected",
            "Inspect the published branch before retrying publication.",
          );
        }
      }
      const comparisonTree =
        params.parentCommit || row.previousHeadCommit
          ? await git.run(["rev-parse", `${parentCommit}^{tree}`])
          : snapshot.baseTree;
      if (params.bootstrapDraft && comparisonTree !== snapshot.workspaceTree) {
        throw new GitLabPublicationKnownFailure(
          "An empty GitLab bootstrap publication requires an unchanged remote base tree.",
          "workspace_changed",
          "Review the accepted source and remote base before publishing.",
        );
      }
      if (comparisonTree === snapshot.workspaceTree && !params.bootstrapDraft) {
        throw new GitLabPublicationKnownFailure(
          "GitLab publication has no changes.",
          "no_changes",
          "Make or restore a repository change, then retry.",
        );
      }
      params.assertWorkflowChangesAllowed();
      assertAction();
      if (!row.headCommit) {
        await execution.updateHead(git.headCommit);
      }
      assertAction();
      // Retrying after updateHead must also finish the local CAS before a push.
      // The owner makes this idempotent when the exact commit is already installed.
      await params.commitLocally({ headCommit: git.headCommit, directory: git.directory });
      assertAction();
      if (remoteHead !== git.headCommit) {
        await execution.recordEffect("push");
        dispatched = true;
        assertAction();
        await pushGitLabPublicationCommit({
          target,
          branch: row.branch,
          expectedHead: remoteHead,
          git,
          credentials: params.credentials,
          assertCurrent: assertAction,
        });
        const observed = await observeGitLabPublicationHead({
          target,
          branch: row.branch,
          credentials: params.credentials,
          git,
          assertCurrent: assertAction,
        });
        if (observed !== git.headCommit) {
          throw new Error("GitLab publication push verification failed.");
        }
        await execution.recordEffect("push", { headCommit: git.headCommit });
      }
      const mrPath = `projects/${target.projectId}/merge_requests`;
      const assertMergeRequestTarget = (mr: ReturnType<typeof parseGitLabMergeRequest>) => {
        const expectedMrUrl = new URL(`-/merge_requests/${mr.iid}`, `${target.webUrl}/`);
        if (
          mr.webUrl !== expectedMrUrl.toString() ||
          mr.sourceProjectId !== target.projectId ||
          mr.targetProjectId !== target.projectId ||
          mr.sourceBranch !== row.branch ||
          mr.targetBranch !== target.baseBranch
        ) {
          throw new Error("GitLab publication merge request target changed.");
        }
      };
      const findMergeRequest = async () => {
        let candidate: ReturnType<typeof parseGitLabMergeRequest> | undefined;
        for (let page = 1; page <= 20; page++) {
          const query = new URLSearchParams({
            state: "all",
            source_branch: row.branch,
            target_branch: target.baseBranch,
            per_page: "100",
            page: String(page),
          });
          const value = await api.request({ method: "GET", path: `${mrPath}?${query}` });
          if (!Array.isArray(value)) {
            throw new Error("GitLab publication merge request lookup is invalid.");
          }
          for (const raw of value) {
            const mr = parseGitLabMergeRequest(raw);
            if (
              mr.sourceProjectId !== target.projectId ||
              mr.targetProjectId !== target.projectId ||
              mr.sourceBranch !== row.branch ||
              mr.targetBranch !== target.baseBranch
            ) {
              continue;
            }
            assertMergeRequestTarget(mr);
            if (mr.state !== "opened") {
              if (row.previousHeadCommit || mr.description.includes(marker)) {
                throw new GitLabPublicationKnownFailure(
                  "The original GitLab merge request was closed.",
                  "gitlab_rejected",
                  "Reopen the original merge request before retrying.",
                );
              }
              continue;
            }
            if (mr.sha !== git.headCommit) {
              throw new Error("The original GitLab merge request head is unconfirmed.");
            }
            // A later publisher may extend a different human's original MR.
            // The exact source branch and current SHA bind this reuse; authorship
            // remains the immutable MR author's ID, separate from this publisher.
            if (
              row.previousHeadCommit ||
              (mr.authorId === identity.accountId && mr.description.includes(marker))
            ) {
              if (candidate && candidate.iid !== mr.iid) {
                throw new Error("GitLab publication found multiple matching merge requests.");
              }
              candidate = mr;
            } else {
              throw new Error("GitLab publication branch has an unrelated merge request.");
            }
          }
          if (value.length < 100) {
            return candidate;
          }
        }
        throw new Error("GitLab publication merge request lookup exceeded its page limit.");
      };
      const wantedTitle = params.draft ? `Draft: ${params.title.trim()}` : params.title.trim();
      let mr = await findMergeRequest();
      if (!mr && row.lastEffect === "pull_request") {
        throw new Error("The original GitLab merge request effect is unconfirmed.");
      }
      if (mr) {
        await execution.recordEffect("pull_request", { url: mr.webUrl });
      } else {
        await execution.recordEffect("pull_request");
        dispatched = true;
        assertAction();
        const created = await api.request({
          method: "POST",
          path: mrPath,
          body: {
            source_branch: row.branch,
            target_branch: target.baseBranch,
            title: wantedTitle,
            description: `${params.description.trimEnd()}\n\n${marker}`,
          },
        });
        // Creation may return before GitLab populates the SHA. Read only the
        // created IID until its exact head and actor are visible; never POST again.
        if (!isRecord(created) || !Number.isSafeInteger(created.iid)) {
          throw new Error("GitLab publication merge request creation is unconfirmed.");
        }
        const createdIid = Number(created.iid);
        for (let attempt = 0; attempt < 3; attempt++) {
          const observed = parseGitLabMergeRequest(
            await api.request({
              method: "GET",
              path: `${mrPath}/${createdIid}`,
            }),
          );
          if (observed.iid !== createdIid) {
            throw new Error("GitLab publication merge request identity changed.");
          }
          assertMergeRequestTarget(observed);
          if (
            observed.state !== "opened" ||
            observed.authorId !== identity.accountId ||
            !observed.description.includes(marker)
          ) {
            throw new Error("GitLab publication merge request actor changed.");
          }
          if (observed.sha === git.headCommit) {
            mr = observed;
            break;
          }
          if (observed.sha !== null) {
            throw new Error("GitLab publication merge request head changed.");
          }
          if (attempt < 2) {
            await new Promise((resolve) => {
              setTimeout(resolve, 150 * (attempt + 1));
            });
            assertAction();
          }
        }
        if (!mr) {
          throw new Error("GitLab publication merge request creation is unconfirmed.");
        }
        await execution.recordEffect("pull_request", { url: mr.webUrl });
      }
      assertAction();
      return await execution.complete({
        status: "published",
        requestId: row.requestId,
        url: mr.webUrl,
        repository: target.projectPath,
        branch: row.branch,
        headCommit: git.headCommit,
        publisherAccountId: identity.accountId,
        mergeRequestAuthorId: mr.authorId,
      });
    } finally {
      await git.close();
    }
  } catch (error) {
    // Lost owner authority is never a terminal provider failure.
    assertAction();
    if (dispatched) {
      return await execution.interrupt();
    }
    const failure = error instanceof GitLabPublicationKnownFailure ? error : undefined;
    return await execution.complete({
      status: "failed",
      requestId: row.requestId,
      code: failure?.code ?? "unavailable",
      nextAction:
        failure?.nextAction ??
        "Restore GitLab access and inspect the accepted checkpoint before retrying.",
      message: "GitLab publication failed.",
    });
  }
}
