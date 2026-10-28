import {
  createGitLabPublicationApi,
  parseGitLabMergeRequest,
  type GitLabPublicationTarget,
} from "./gitlab-publication-adapter.js";

export function assertGitLabMergeRequestTarget(
  mr: ReturnType<typeof parseGitLabMergeRequest>,
  target: GitLabPublicationTarget,
  branch: string,
): void {
  if (
    mr.webUrl !== new URL(`-/merge_requests/${mr.iid}`, `${target.webUrl}/`).toString() ||
    mr.sourceProjectId !== target.projectId ||
    mr.targetProjectId !== target.projectId ||
    mr.sourceBranch !== branch ||
    mr.targetBranch !== target.baseBranch
  ) {
    throw new Error("GitLab publication merge request target changed.");
  }
}

/** Read-only reconciliation shared by first publication and uncertain-effect recovery. */
export async function findGitLabPublicationMergeRequest(params: {
  api: Pick<ReturnType<typeof createGitLabPublicationApi>, "request">;
  target: GitLabPublicationTarget;
  branch: string;
  headCommit: string;
  previousHeadCommit: string | null;
  accountId: number;
  requestId: string;
  onClosed?: () => never;
}) {
  const { api, target, branch, headCommit, previousHeadCommit, accountId, requestId } = params;
  const marker = `<!-- openclaw-publication:${requestId} -->`;
  let candidate: ReturnType<typeof parseGitLabMergeRequest> | undefined;
  for (let page = 1; page <= 20; page++) {
    const query = new URLSearchParams({
      state: "all",
      source_branch: branch,
      target_branch: target.baseBranch,
      per_page: "100",
      page: String(page),
    });
    const rows = await api.request({
      method: "GET",
      path: `projects/${target.projectId}/merge_requests?${query}`,
    });
    if (!Array.isArray(rows)) {
      throw new Error("GitLab publication merge request lookup is invalid.");
    }
    for (const raw of rows) {
      const mr = parseGitLabMergeRequest(raw);
      if (
        mr.sourceProjectId !== target.projectId ||
        mr.targetProjectId !== target.projectId ||
        mr.sourceBranch !== branch ||
        mr.targetBranch !== target.baseBranch
      ) {
        continue;
      }
      assertGitLabMergeRequestTarget(mr, target, branch);
      if (mr.state !== "opened") {
        if (previousHeadCommit || mr.description.includes(marker)) {
          if (params.onClosed) {
            params.onClosed();
          }
          throw new Error(
            "The original GitLab merge request was closed; reopen it before retrying.",
          );
        }
        continue;
      }
      if (mr.sha !== headCommit) {
        throw new Error("The original GitLab merge request head is unconfirmed.");
      }
      // Existing branches may retain a different original MR author.
      if (!previousHeadCommit && (mr.authorId !== accountId || !mr.description.includes(marker))) {
        throw new Error("GitLab publication branch has an unrelated merge request.");
      }
      if (candidate && candidate.iid !== mr.iid) {
        throw new Error("GitLab publication found multiple matching merge requests.");
      }
      candidate = mr;
    }
    if (rows.length < 100) {
      return candidate;
    }
  }
  throw new Error("GitLab publication merge request lookup exceeded its page limit.");
}
