import fs from "node:fs";
import path from "node:path";
import { runGit } from "../agents/worktrees/git.js";
import { requireGitCommandOutput } from "../infra/git-exec.js";
import type { GitMergedPullHead as MergedPullHead } from "../infra/git-read-operations.js";
import { readGitHead, readGitRefs, resolveGitRefsBase } from "../infra/git-root.js";
import { canReadGitFilesystemRefs } from "../infra/git-worker-context.js";

type BranchLanding = {
  /** origin/<branch> tip when the remote-tracking ref resolves. */
  pushedSha: string | null;
  defaultSha: string | null;
  /** Newest known-published commit to diff the working tree against. */
  statsBase: string | null;
  /** At least one merged PR provably landed on the default branch. */
  hasLandedPullRequest: boolean;
  /** The merge base contains every known landing, so Create PR is safe. */
  provenNewPushedWork: boolean;
};

/** Only ordinary file-backed refs bypass Git; unusual discovery/layouts retain its semantics. */
export function readCheckoutHead(
  root: string,
): { sha: string; branch?: string | null; refsBase: string } | null {
  if (!canReadGitFilesystemRefs()) {
    return null;
  }
  try {
    const head = readGitHead(root, { maxDepth: 1 });
    if (
      !head?.value ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head.value) ||
      fs.lstatSync(head.headPath).isSymbolicLink()
    ) {
      return null;
    }
    // Git prints lowercase object IDs even when a ref file uses uppercase.
    const sha = head.value.toLowerCase();
    const refsBase = head.refsBase ?? resolveGitRefsBase(head.headPath);
    if (
      fs.existsSync(path.join(refsBase, "reftable")) ||
      (head.ref !== null && !head.ref.startsWith("refs/heads/"))
    ) {
      return null;
    }
    const branch = head.ref?.slice("refs/heads/".length) ?? null;
    // Git resolves these names through packed, per-worktree, or virtual ref scopes.
    if (
      branch !== null &&
      /^(?:[A-Z_]+$|(?:refs|bisect|worktree|rewritten|main-worktree|worktrees)\/)/.test(branch)
    ) {
      return null;
    }
    const headAliases = [
      "refs/HEAD",
      "refs/tags/HEAD",
      "refs/heads/HEAD",
      "refs/remotes/HEAD",
      "refs/remotes/HEAD/HEAD",
    ];
    const branchAliases =
      branch === null
        ? []
        : [
            `refs/${branch}`,
            `refs/tags/${branch}`,
            `refs/remotes/${branch}`,
            `refs/remotes/${branch}/HEAD`,
          ];
    const aliases = readGitRefs(refsBase, [...headAliases, ...branchAliases]);
    if (headAliases.some((ref) => aliases.get(ref) !== null)) {
      return null;
    }
    if (branch === null) {
      return { sha, branch, refsBase };
    }
    // rev-parse uses a qualified name when another ref makes the short name ambiguous.
    const ambiguous =
      fs.existsSync(path.join(refsBase, branch)) ||
      branchAliases.some((ref) => aliases.get(ref) !== null);
    return { sha, refsBase, ...(ambiguous ? {} : { branch }) };
  } catch {
    return null;
  }
}

export async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await runGit(cwd, args);
    return result.code === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

async function readRemoteRevisions(
  root: string,
  refs: string[],
  head: ReturnType<typeof readCheckoutHead>,
): Promise<Map<string, string>> {
  if (head) {
    try {
      const values = readGitRefs(head.refsBase, refs);
      if (
        refs.every((ref) => {
          const value = values.get(ref);
          return (
            !ref.split("/").includes("..") &&
            !fs
              .lstatSync(path.join(head.refsBase, ref), { throwIfNoEntry: false })
              ?.isSymbolicLink() &&
            (value === null ||
              (typeof value === "string" &&
                value.length === head.sha.length &&
                /^[a-f0-9]+$/i.test(value)))
          );
        })
      ) {
        return new Map(
          [...values].flatMap(([ref, value]) => (value ? [[ref, value.toLowerCase()]] : [])),
        );
      }
    } catch {
      // Symbolic, malformed, or unreadable refs retain Git's resolution semantics.
    }
  }
  try {
    // These fields read stored IDs without loading or lazily fetching partial-clone objects.
    const result = await runGit(
      root,
      ["for-each-ref", "--format=%(refname)%00%(objectname)", "--", ...refs],
      { maxOutputBytes: 16 * 1024, terminateOnOutputLimit: true },
    );
    const output = requireGitCommandOutput("git for-each-ref", result);
    const revisions = new Map<string, string>();
    for (const line of output.trim().split("\n")) {
      const separator = line.indexOf("\0");
      const ref = line.slice(0, separator);
      // Ref patterns also match descendants; only exact requested refs identify these tips.
      if (separator > 0 && refs.includes(ref)) {
        revisions.set(ref, line.slice(separator + 1));
      }
    }
    return revisions;
  } catch {
    // A failed or oversized ref inventory must not hide independently readable tips.
    const revisions = new Map<string, string>();
    for (const ref of refs) {
      const revision = await gitOutput(root, ["rev-parse", "--verify", "--quiet", ref]);
      if (revision) {
        revisions.set(ref, revision);
      }
    }
    return revisions;
  }
}

async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    const result = await runGit(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return result.code === 0;
  } catch {
    return false;
  }
}

/** Prefer a maximal published baseline containing the merge base, then input order. */
async function maximalCommit(root: string, candidates: readonly string[]): Promise<string | null> {
  const unique = [...new Set(candidates)];
  const first = unique[0];
  if (first === undefined) {
    return null;
  }
  if (unique.length === 1) {
    return first;
  }
  const second = unique[1];
  if (unique.length === 2 && second !== undefined) {
    return (await isAncestor(root, first, second)) ? second : first;
  }
  // A failed lookup retains the merge base, the first candidate.
  const out = await gitOutput(root, ["merge-base", "--independent", ...unique]);
  if (!out) {
    return first;
  }
  const independent = new Set(
    out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const maxima = unique.filter((candidate) => independent.has(candidate));
  for (const candidate of maxima) {
    if (candidate === first || maxima.length === 1 || (await isAncestor(root, first, candidate))) {
      return candidate;
    }
  }
  return maxima[0] ?? first;
}

export async function resolveBranchLanding(
  root: string,
  params: {
    branch: string;
    defaultBranch?: string;
    mergedHeads: readonly MergedPullHead[];
  },
): Promise<BranchLanding> {
  const pushedRef = `refs/remotes/origin/${params.branch}`;
  const defaultRef = params.defaultBranch ? `refs/remotes/origin/${params.defaultBranch}` : null;
  const checkoutHead = readCheckoutHead(root);
  const revisions = await readRemoteRevisions(
    root,
    [pushedRef, ...(defaultRef ? [defaultRef] : [])],
    checkoutHead,
  );
  const pushedSha = revisions.get(pushedRef) ?? null;
  const headSha =
    checkoutHead?.sha ?? (await gitOutput(root, ["rev-parse", "--verify", "--quiet", "HEAD"]));
  const defaultSha = defaultRef ? (revisions.get(defaultRef) ?? null) : null;
  const possibleLandings = params.mergedHeads.filter(
    (head) =>
      head.baseRef === params.defaultBranch || Boolean(params.defaultBranch && head.mergeCommitSha),
  );
  // Indirect landings count only after their merge reaches this checkout's default
  // branch. The shared snapshot cache cannot filter these: its key has no default branch.
  const landedHeads: MergedPullHead[] = [];
  for (const head of possibleLandings) {
    if (head.baseRef === params.defaultBranch) {
      landedHeads.push(head);
    } else if (
      defaultSha &&
      head.mergeCommitSha &&
      (await isAncestor(root, head.mergeCommitSha, defaultSha))
    ) {
      landedHeads.push(head);
    }
  }
  // PRs may share a head; their distinct landing receipts still need individual checks below.
  const landedShas = new Set(landedHeads.map((head) => head.sha));
  const mergeBase =
    defaultSha && headSha ? await gitOutput(root, ["merge-base", defaultSha, headSha]) : null;
  // Squashed PR heads may not be ancestors of the default branch. A related
  // published head avoids replaying landed work; unreadable ancestry keeps the merge base.
  const baselines: string[] = mergeBase ? [mergeBase] : [];
  if (headSha) {
    for (const merged of landedShas) {
      if (await isAncestor(root, merged, headSha)) {
        baselines.push(merged);
      } else if (await isAncestor(root, headSha, merged)) {
        baselines.push(headSha);
      }
    }
  }
  const statsBase = await maximalCommit(root, baselines);
  // Squashed branches stay ahead of the default branch. Offer Create PR again
  // only when the merge base contains every known landing, by merge commit or head.
  let provenNewPushedWork = false;
  if (pushedSha && mergeBase && !landedShas.has(pushedSha.toLowerCase())) {
    provenNewPushedWork = landedHeads.length > 0;
    for (const head of landedHeads) {
      const incorporated =
        (head.mergeCommitSha ? await isAncestor(root, head.mergeCommitSha, mergeBase) : false) ||
        (await isAncestor(root, head.sha, mergeBase));
      if (!incorporated) {
        provenNewPushedWork = false;
        break;
      }
    }
  }
  return {
    pushedSha,
    defaultSha,
    statsBase,
    hasLandedPullRequest: landedHeads.length > 0,
    provenNewPushedWork,
  };
}
