import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createRetainedCache } from "../infra/retained-cache.js";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import type { ControlUiSessionPullRequest } from "./control-ui-contract.js";
import { prepareSessionPullRequestGitHubRead } from "./control-ui-session-pr-request.js";
import { sessionPullRequestRepositoryApiUrl } from "./control-ui-session-prs-checks.js";

type AcceptedSnapshot = Pick<
  GitHubPublicationExecutionRow,
  "repository" | "branch" | "source_head_commit" | "workspace_tree"
>;
const gitObjectId = /^[a-f0-9]{40}$/iu;
// Retain completed immutable proofs only; pending reads keep their own live authority.
const coverage = createRetainedCache<number>();
const COVERAGE_TTL_MS = 90_000;

/** Published history can supersede a failed attempt without changing its durable outcome. */
export async function isGitHubPublicationSuperseded(
  snapshot: AcceptedSnapshot,
  readPublished: () => Promise<
    { pullRequests: readonly ControlUiSessionPullRequest[]; assertCurrent: () => void } | undefined
  >,
): Promise<boolean> {
  const tree = snapshot.workspace_tree;
  if (!tree || !gitObjectId.test(tree)) {
    return false;
  }
  const history = await readPublished();
  if (!history) {
    return false;
  }
  const { pullRequests, assertCurrent } = history;
  assertCurrent();
  const candidates = pullRequests.flatMap((pr) => {
    const head = pr.headSha;
    return pr.state !== "closed" &&
      pr.branch === snapshot.branch &&
      (!snapshot.repository ||
        snapshot.repository.toLowerCase() === `${pr.owner}/${pr.repo}`.toLowerCase()) &&
      head &&
      gitObjectId.test(head)
      ? [{ pr, head }]
      : [];
  });
  if (candidates.length === 0) {
    return false;
  }
  // The PR reader admits one recorded repository host before returning its candidates.
  const read = prepareSessionPullRequestGitHubRead(
    new URL(candidates[0]!.pr.url).hostname,
    assertCurrent,
    { optionalAuth: false },
  );
  for (const { pr, head } of candidates) {
    try {
      const root = sessionPullRequestRepositoryApiUrl({ ...pr, apiBaseUrl: read.apiBaseUrl });
      const key = JSON.stringify([read.cacheScope, root, head, tree, snapshot.source_head_commit]);
      read.assertCurrent();
      if ((coverage.get(key) ?? 0) > Date.now()) {
        return true;
      }
      // Git commit metadata omits file patches and proves dirty/re-written snapshots
      // when the published tree is byte-for-byte identical to the accepted tree.
      const published = await read.request(`${root}/git/commits/${head}`);
      if (
        !isRecord(published) ||
        published.sha !== head ||
        !isRecord(published.tree) ||
        typeof published.tree.sha !== "string" ||
        !gitObjectId.test(published.tree.sha)
      ) {
        continue;
      }
      if (published.tree.sha === tree) {
        coverage.set(key, Date.now() + COVERAGE_TTL_MS);
        return true;
      }
      const source = snapshot.source_head_commit;
      if (!source || source === head || !gitObjectId.test(source)) {
        continue;
      }
      // Page two retains comparison metadata without the first page’s file patches.
      // Only an accepted *committed* snapshot can use ancestry as coverage proof.
      const compared = await read.request(`${root}/compare/${source}...${head}?per_page=1&page=2`);
      if (!isRecord(compared) || (compared.status !== "ahead" && compared.status !== "identical")) {
        continue;
      }
      const base = isRecord(compared.base_commit) ? compared.base_commit : null;
      const commit = base && isRecord(base.commit) ? base.commit : null;
      const baseTree = commit && isRecord(commit.tree) ? commit.tree : null;
      const mergeBase = isRecord(compared.merge_base_commit) ? compared.merge_base_commit : null;
      if (base?.sha === source && mergeBase?.sha === source && baseTree?.sha === tree) {
        coverage.set(key, Date.now() + COVERAGE_TTL_MS);
        return true;
      }
    } catch {
      // One unavailable head does not disprove coverage by another matching PR.
      // The shared transport owns cooldowns; never switch identities or suppress
      // revoked authority while continuing through candidates.
      read.assertCurrent();
    }
  }
  return false;
}
