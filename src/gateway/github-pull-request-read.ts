import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { PreparedGitHubReadIdentity } from "../agents/github-read-identity.js";
import { gitHubPublicApi } from "./github-public-api.js";

const BODY_CHARS = 24 * 1024;
const PATCH_CHARS = 4 * 1024;
const REVIEW_BODY_CHARS = 2 * 1024;
const FILE_LIMIT = 20;
const REVIEW_LIMIT = 20;
const RESPONSE_BYTES = 512 * 1024;

type PullRequestTarget = { owner: string; repo: string; number: number };

function record(value: unknown, message: string): Record<string, unknown> {
  if (!gitHubPublicApi.isRecord(value)) {
    throw new gitHubPublicApi.ControlUiGitHubError(502, message);
  }
  return value;
}

function array(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new gitHubPublicApi.ControlUiGitHubError(502, message);
  }
  return value;
}

function integer(value: Record<string, unknown>, key: string): number {
  const result = gitHubPublicApi.optionalNumber(value, key);
  if (result === undefined || !Number.isSafeInteger(result) || result < 0) {
    throw new gitHubPublicApi.ControlUiGitHubError(502, `GitHub response omitted ${key}`);
  }
  return result;
}

function actor(value: Record<string, unknown>): string {
  return gitHubPublicApi.isRecord(value.user)
    ? (gitHubPublicApi.readOptionalGitHubString(value.user, "login") ?? "ghost")
    : "ghost";
}

function branch(value: Record<string, unknown>, key: "base" | "head") {
  const selected = record(value[key], `GitHub response omitted ${key}`);
  const repository =
    key === "head" && selected.repo === null
      ? undefined
      : record(selected.repo, `GitHub response omitted ${key} repository`);
  return {
    label: gitHubPublicApi.requiredString(selected, "label"),
    ref: gitHubPublicApi.requiredString(selected, "ref"),
    sha: gitHubPublicApi.requiredString(selected, "sha"),
    ...(repository ? { repository: gitHubPublicApi.requiredString(repository, "full_name") } : {}),
  };
}

/** Read one PR through the Gateway-owned credential without exposing a generic GitHub transport. */
export async function readBoundGitHubPullRequest(params: {
  target: PullRequestTarget;
  identity: PreparedGitHubReadIdentity;
}) {
  const repositoryUrl = `${gitHubPublicApi.GITHUB_API_BASE_URL}/repos/${encodeURIComponent(params.target.owner)}/${encodeURIComponent(params.target.repo)}`;
  const rejectRedirect = async () => {
    throw new gitHubPublicApi.ControlUiGitHubError(
      409,
      "GitHub repository changed while loading the selected pull request",
    );
  };
  const read = async (url: string) =>
    await gitHubPublicApi.readGitHubJsonResponse(
      await gitHubPublicApi.fetchGitHubApi(
        url,
        fetch,
        params.identity.token,
        rejectRedirect,
        params.identity,
      ),
      RESPONSE_BYTES,
    );
  const [rawPullRequest, rawFiles, rawReviews] = await Promise.all([
    read(`${repositoryUrl}/pulls/${params.target.number}`),
    read(`${repositoryUrl}/pulls/${params.target.number}/files?per_page=${FILE_LIMIT}`),
    read(`${repositoryUrl}/pulls/${params.target.number}/reviews?per_page=${REVIEW_LIMIT + 1}`),
  ]);
  const pullRequest = record(rawPullRequest, "GitHub pull request was not an object");
  const body = gitHubPublicApi.readOptionalGitHubString(pullRequest, "body") ?? "";
  const files = array(rawFiles, "GitHub pull request files were not an array")
    .slice(0, FILE_LIMIT)
    .map((value) => {
      const file = record(value, "GitHub pull request file was not an object");
      const patch = gitHubPublicApi.readOptionalGitHubString(file, "patch");
      const result: {
        path: string;
        status: string;
        additions: number;
        deletions: number;
        changes: number;
        patch?: string;
        patch_truncated?: true;
      } = {
        path: truncateUtf16Safe(gitHubPublicApi.requiredString(file, "filename"), 1024),
        status: gitHubPublicApi.requiredString(file, "status"),
        additions: integer(file, "additions"),
        deletions: integer(file, "deletions"),
        changes: integer(file, "changes"),
      };
      if (patch !== undefined) {
        result.patch = truncateUtf16Safe(patch, PATCH_CHARS);
        result.patch_truncated = patch.length > PATCH_CHARS || undefined;
      }
      return result;
    });
  const reviewPage = array(rawReviews, "GitHub pull request reviews were not an array");
  const reviews = reviewPage.slice(0, REVIEW_LIMIT).map((value) => {
    const review = record(value, "GitHub pull request review was not an object");
    const reviewBody = gitHubPublicApi.readOptionalGitHubString(review, "body") ?? "";
    return {
      author: actor(review),
      state: gitHubPublicApi.requiredString(review, "state"),
      submitted_at: gitHubPublicApi.readOptionalGitHubString(review, "submitted_at"),
      body: truncateUtf16Safe(reviewBody, REVIEW_BODY_CHARS),
      body_truncated: reviewBody.length > REVIEW_BODY_CHARS || undefined,
    };
  });
  return {
    content_trust: "untrusted_external_content" as const,
    repository: `${params.target.owner}/${params.target.repo}`,
    number: params.target.number,
    url: gitHubPublicApi.requiredString(pullRequest, "html_url"),
    title: truncateUtf16Safe(gitHubPublicApi.requiredString(pullRequest, "title"), 512),
    body: truncateUtf16Safe(body, BODY_CHARS),
    body_truncated: body.length > BODY_CHARS || undefined,
    state: gitHubPublicApi.requiredString(pullRequest, "state"),
    draft: pullRequest.draft === true,
    author: actor(pullRequest),
    base: branch(pullRequest, "base"),
    head: branch(pullRequest, "head"),
    files,
    files_total: integer(pullRequest, "changed_files"),
    files_truncated: integer(pullRequest, "changed_files") > files.length || undefined,
    reviews,
    reviews_truncated: reviewPage.length > reviews.length || undefined,
    issue_comments: {
      available: false as const,
      reason:
        "Issue-conversation comments are unavailable to this reader because the installed credential currently grants pull-request reads only.",
    },
  };
}
