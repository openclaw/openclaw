import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import type { ControlUiSessionPullRequest } from "./control-ui-contract.js";
import { gitHubPublicApi } from "./github-public-api.js";

type AcceptedSnapshot = Pick<
  GitHubPublicationExecutionRow,
  "repository" | "branch" | "source_head_commit" | "workspace_tree"
>;
const gitObjectId = /^[a-f0-9]{40}$/iu;

/** Published history can supersede a failed attempt without changing its durable outcome. */
export async function isGitHubPublicationSuperseded(
  snapshot: AcceptedSnapshot,
  pullRequests: readonly ControlUiSessionPullRequest[],
  { fetchImpl = fetch, assertCurrent }: { fetchImpl?: typeof fetch; assertCurrent: () => void },
): Promise<boolean> {
  assertCurrent();
  const tree = snapshot.workspace_tree;
  if (!tree || !gitObjectId.test(tree)) {
    return false;
  }
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
  const identity = gitHubPublicApi.resolveGitHubApiCredentialScope();
  const assertSelected = () => {
    assertCurrent();
    if (gitHubPublicApi.resolveGitHubApiCredentialScope().cacheScope !== identity.cacheScope) {
      throw new Error("GitHub observation identity changed.");
    }
  };
  const read = async (url: string): Promise<unknown> => {
    assertSelected();
    const response = await gitHubPublicApi.fetchGitHubApi(
      url,
      fetchImpl,
      identity.token,
      undefined,
      {
        assertSelected,
        revalidate: async () => assertSelected(),
      },
    );
    const value = await gitHubPublicApi.readGitHubJsonResponse(response);
    assertSelected();
    return value;
  };
  for (const { pr, head } of candidates) {
    try {
      const root = `${gitHubPublicApi.GITHUB_API_ORIGIN}/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}`;
      // Git commit metadata omits file patches and proves dirty/re-written snapshots
      // when the published tree is byte-for-byte identical to the accepted tree.
      const published = await read(`${root}/git/commits/${head}`);
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
        return true;
      }
      const source = snapshot.source_head_commit;
      if (!source || source === head || !gitObjectId.test(source)) {
        continue;
      }
      // Page two retains comparison metadata without the first page’s file patches.
      // Only an accepted *committed* snapshot can use ancestry as coverage proof.
      const compared = await read(`${root}/compare/${source}...${head}?per_page=1&page=2`);
      if (!isRecord(compared) || (compared.status !== "ahead" && compared.status !== "identical")) {
        continue;
      }
      const base = isRecord(compared.base_commit) ? compared.base_commit : null;
      const commit = base && isRecord(base.commit) ? base.commit : null;
      const baseTree = commit && isRecord(commit.tree) ? commit.tree : null;
      const mergeBase = isRecord(compared.merge_base_commit) ? compared.merge_base_commit : null;
      if (base?.sha === source && mergeBase?.sha === source && baseTree?.sha === tree) {
        return true;
      }
    } catch {
      // One unavailable head does not disprove coverage by another matching PR.
      // The shared transport owns cooldowns; never switch identities or suppress
      // revoked authority while continuing through candidates.
      assertSelected();
    }
  }
  return false;
}
