import fs from "node:fs";
import nodePath from "node:path";
import { readRegularFile } from "@openclaw/fs-safe/advanced";
import { unavailableDiffRevision, type DiffReadTiming } from "../infra/diff-read-timing.js";
import { listDirectoryTreeStrictSync } from "../infra/directory-walk.js";
import { GitCommandTimeoutError, requireGitCommandOutput } from "../infra/git-exec.js";
import type { GitReadOperations } from "../infra/git-read-operations.js";
import { readGitHead, readGitMetadataPrefix, readGitRefs } from "../infra/git-root.js";
import { canReadGitFilesystemRefs } from "../infra/git-worker-context.js";
import type { GitWorkerOperations } from "../infra/git-worker-contract.js";
import { readCheckoutDiffRevision } from "./control-ui-session-diff-revision.js";
import {
  gitOutput,
  isAncestor,
  runPullRequestGit,
  readCheckoutHead,
  readRemoteRevisions,
  resolveBranchLanding,
} from "./control-ui-session-prs-landing.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";

/** Observe only this checkout's refs; snapshot publication does not change PR facts. */
export async function readCheckoutGitRevision(
  {
    root,
    scope,
    branch,
    defaultBranch,
    summaryOnly = false,
    paths: diffPaths,
  }: GitReadOperations["checkout.revision"]["input"],
  timing?: DiffReadTiming,
): Promise<GitReadOperations["checkout.revision"]["output"]> {
  if (!canReadGitFilesystemRefs()) {
    return unavailableDiffRevision(timing, "no-revision-environment");
  }
  try {
    if (scope === "diff") {
      return await readCheckoutDiffRevision(root, diffPaths, summaryOnly, timing);
    }
    const head = readGitHead(root, { maxDepth: 1 });
    const checkout = readCheckoutHead(root, head);
    const defaultRef = readDefaultRef(checkout);
    if (
      !head ||
      !checkout ||
      checkout.branch === undefined ||
      (scope === "context" && defaultRef === undefined)
    ) {
      return null;
    }
    const gitDir = nodePath.dirname(head.headPath);
    const paths = [
      nodePath.join(root, ".git"),
      nodePath.join(checkout.refsBase, "config"),
      nodePath.join(gitDir, "config.worktree"),
    ];
    if (scope === "worktree") {
      paths.push(nodePath.join(gitDir, "index"));
    }
    const replacements = nodePath.join(checkout.refsBase, "refs/replace");
    let packedReplacements: string[] = [];
    if (scope !== "context") {
      paths.push(
        nodePath.join(checkout.refsBase, "shallow"),
        nodePath.join(checkout.refsBase, "info/grafts"),
      );
      if (fs.existsSync(replacements)) {
        paths.push(
          ...listDirectoryTreeStrictSync(replacements).map(({ relativePath }) =>
            nodePath.join(replacements, relativePath),
          ),
        );
      }
      const packed = nodePath.join(checkout.refsBase, "packed-refs");
      if (fs.existsSync(packed)) {
        packedReplacements = fs
          .readFileSync(packed, "utf8")
          .split("\n")
          .filter((line) => /\srefs\/replace\//u.test(line))
          .toSorted();
      }
    }
    const selectedBranch = branch ?? checkout.branch;
    const selectedDefault = defaultBranch ? `origin/${defaultBranch}` : defaultRef;
    const tips =
      scope !== "context"
        ? await readRemoteRevisions(
            root,
            [
              ...(selectedBranch ? [`refs/remotes/origin/${selectedBranch}`] : []),
              ...(selectedDefault ? [`refs/remotes/${selectedDefault}`] : []),
            ],
            checkout,
          )
        : [];
    return {
      key: JSON.stringify([
        // Context exposes branch names and remote configuration, not commit IDs.
        scope !== "context" ? checkout : { branch: checkout.branch, refsBase: checkout.refsBase },
        defaultRef,
        [...tips],
        packedReplacements,
        paths.toSorted().map((file) => {
          const stat = fs.lstatSync(file, { throwIfNoEntry: false });
          if (
            stat?.isSymbolicLink() ||
            (stat?.isFile() &&
              file.startsWith(`${replacements}${nodePath.sep}`) &&
              readGitMetadataPrefix(file).startsWith("ref:"))
          ) {
            throw new Error("Symbolic Git metadata requires Git discovery");
          }
          return stat?.isDirectory()
            ? [file, stat.dev, stat.ino]
            : [file, stat?.ino, stat?.size, stat?.mtimeMs, stat?.ctimeMs];
        }),
      ]),
    };
  } catch (error) {
    return unavailableDiffRevision(timing, undefined, error);
  }
}

function readDefaultRef(head: ReturnType<typeof readCheckoutHead>): string | null | undefined {
  if (!head) {
    return undefined;
  }
  try {
    const ref = "refs/remotes/origin/HEAD";
    if (
      fs.lstatSync(nodePath.join(head.refsBase, ref), { throwIfNoEntry: false })?.isSymbolicLink()
    ) {
      return undefined;
    }
    const raw = readGitRefs(head.refsBase, [ref]).get(ref);
    if (raw === null) {
      return null;
    }
    const match = /^ref:\s+(refs\/remotes\/(origin\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*))$/u.exec(
      raw ?? "",
    );
    if (!match) {
      return undefined;
    }
    const target = match[1]!;
    const short = match[2]!;
    const aliases = [
      `refs/${short}`,
      `refs/tags/${short}`,
      `refs/heads/${short}`,
      `refs/remotes/${short}/HEAD`,
    ];
    const values = readGitRefs(head.refsBase, [target, ...aliases]);
    const value = values.get(target);
    // Symbolic chains and ambiguous names retain Git's resolution/shortening semantics.
    return (value === null || /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(value ?? "")) &&
      !fs
        .lstatSync(nodePath.join(head.refsBase, target), { throwIfNoEntry: false })
        ?.isSymbolicLink() &&
      !fs.existsSync(nodePath.join(head.refsBase, short)) &&
      aliases.every((alias) => values.get(alias) === null)
      ? short
      : undefined;
  } catch {
    return undefined;
  }
}

export async function readCheckoutGitContext(
  root: string,
  githubHost = "github.com",
): Promise<GitReadOperations["checkout.context"]["output"]> {
  const head = readCheckoutHead(root);
  const branch =
    head?.branch === null
      ? "HEAD"
      : (head?.branch ?? (await gitOutput(root, ["rev-parse", "--abbrev-ref", "HEAD"])));
  if (!branch) {
    return null;
  }
  const remoteUrl = await gitOutput(root, ["remote", "get-url", "origin"]);
  const publicRemote = remoteUrl ? parseGitHubRemoteUrl(remoteUrl) : null;
  const remote = publicRemote ?? (remoteUrl ? parseGitHubRemoteUrl(remoteUrl, githubHost) : null);
  if (!remote) {
    return null;
  }
  const preparedDefaultRef = readDefaultRef(head);
  const defaultRef =
    preparedDefaultRef === undefined
      ? await gitOutput(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
      : preparedDefaultRef;
  const defaultBranch = defaultRef?.replace(/^origin\//, "");
  return {
    ...remote,
    ...(!publicRemote ? { host: githubHost } : {}),
    branch: branch === "HEAD" ? null : branch,
    root,
    ...(defaultBranch ? { defaultBranch } : {}),
  };
}

const SHORTSTAT_FILES = /(\d+) files? changed/;
const SHORTSTAT_INSERTIONS = /(\d+) insertion/;
const SHORTSTAT_DELETIONS = /(\d+) deletion/;
// Matches sessions-diff's untracked scan bound; stats degrade to an
// undercount past it instead of stalling the request.
const MAX_UNTRACKED_STAT_FILES = 100;
// Oversized untracked files count 0 lines instead of being read; the row's
// stats are an approximation, not a patch surface.
const MAX_UNTRACKED_STAT_BYTES = 512 * 1024;

/** Count lines without a subprocess per file; hardlinked content only exposes a count. */
async function untrackedFileAdditions(root: string, filePath: string): Promise<number> {
  try {
    const { buffer: body } = await readRegularFile({
      filePath: nodePath.resolve(root, filePath),
      maxBytes: MAX_UNTRACKED_STAT_BYTES,
    });
    // Binary files count 0 lines, mirroring git's shortstat behavior.
    if (body.length === 0 || body.subarray(0, 8192).includes(0)) {
      return 0;
    }
    let lines = 0;
    for (let index = body.indexOf(10); index !== -1; index = body.indexOf(10, index + 1)) {
      lines += 1;
    }
    // A trailing fragment without a newline is still a line git would add.
    return body[body.length - 1] === 10 ? lines : lines + 1;
  } catch {
    // Unreadable paths just do not count toward the size.
    return 0;
  }
}

async function untrackedStats(root: string): Promise<{ additions: number; files: number }> {
  const listing = await runPullRequestGit(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  // NUL-delimited filenames retain leading whitespace, unlike scalar Git output.
  const output = listing?.code === 0 ? listing.stdout : "";
  let additions = 0;
  let files = 0;
  for (let start = 0; start < output.length;) {
    const separator = output.indexOf("\0", start);
    const end = separator < 0 ? output.length : separator;
    if (end > start && ++files <= MAX_UNTRACKED_STAT_FILES) {
      additions += await untrackedFileAdditions(root, output.slice(start, end));
    }
    start = end + 1;
  }
  return { additions, files };
}

/**
 * Working-tree diff counts vs an explicit base, untracked files included:
 * the size the PR would have if the current work were committed and pushed;
 * changedFiles decides row visibility for unpushed branches. Unlike bare
 * `git diff`, this also counts unmerged (conflict) paths.
 */
async function diffStatsAgainst(
  root: string,
  base: string,
  refreshIndex: boolean,
): Promise<{ additions: number; deletions: number; changedFiles: number } | null> {
  try {
    // Git's shortstat prefetch scans every promisor pack on a missing blob, even
    // with lazy fetching disabled. Admit only locally available diff inputs.
    const inventory = await runPullRequestGit(root, [
      "-c",
      "diff.autoRefreshIndex=false",
      "diff",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "-z",
      base,
      "--",
    ]);
    const objects = new Set<string>();
    const fields = requireGitCommandOutput("git diff --raw", inventory).split("\0");
    for (let i = 0; i < fields.length - 1; i += 2) {
      const [oldMode, newMode, oldObject, newObject] = fields[i]!.slice(1).split(" ");
      for (const [mode, object] of [
        [oldMode, oldObject],
        [newMode, newObject],
      ]) {
        if (mode !== "160000" && object && !/^0+$/u.test(object)) {
          objects.add(object);
        }
      }
    }
    if (objects.size > 0) {
      const input = `${[...objects].join("\n")}\n`;
      const available = await runPullRequestGit(root, ["cat-file", "--batch-check=%(objectname)"], {
        input,
      });
      if (requireGitCommandOutput("git cat-file", available) !== input) {
        return null;
      }
    }
    // Checkout-configurable diff drivers must never execute in the Gateway
    // process (same guard as sessions-diff).
    // Managed checkouts own their index; user checkouts keep read-only stat data.
    const result = await runPullRequestGit(root, [
      "-c",
      `diff.autoRefreshIndex=${refreshIndex}`,
      "diff",
      "--shortstat",
      "--no-ext-diff",
      "--no-textconv",
      base,
    ]);
    if (result.code !== 0) {
      return null;
    }
    // Empty output means an empty diff, not a failure.
    const summary = result.stdout.trim();
    const untracked = await untrackedStats(root);
    return {
      additions: Number(SHORTSTAT_INSERTIONS.exec(summary)?.[1] ?? 0) + untracked.additions,
      deletions: Number(SHORTSTAT_DELETIONS.exec(summary)?.[1] ?? 0),
      changedFiles: Number(SHORTSTAT_FILES.exec(summary)?.[1] ?? 0) + untracked.files,
    };
  } catch (error) {
    if (error instanceof GitCommandTimeoutError) {
      throw error;
    }
    return null;
  }
}

export async function readPullRequestBranchComparison(
  input: GitWorkerOperations["pull-request.branch-comparison"]["input"],
): Promise<GitWorkerOperations["pull-request.branch-comparison"]["output"]> {
  const landing = await resolveBranchLanding(input.root, input);
  const creatable =
    (!landing.hasLandedPullRequest || landing.provenNewPushedWork) &&
    Boolean(input.defaultBranch) &&
    landing.pushedSha !== null &&
    (!landing.defaultSha ||
      !(await isAncestor(input.root, landing.pushedSha, landing.defaultSha, () => {
        landing.complete = false;
      })));
  return {
    complete: landing.complete,
    statsBase: landing.statsBase,
    equalPushedTips:
      landing.defaultSha !== null &&
      landing.defaultSha === landing.pushedSha &&
      landing.statsBase === landing.defaultSha,
    creatable,
  };
}

export async function readPullRequestBranchFacts(
  input: GitWorkerOperations["pull-request.branch-facts"]["input"],
): Promise<GitReadOperations["pull-request.branch-facts"]["output"]> {
  const { comparison } = input;
  const stats = comparison.statsBase
    ? await diffStatsAgainst(input.root, comparison.statsBase, input.refreshIndex === true)
    : null;
  const creatable = comparison.creatable && !(stats !== null && comparison.equalPushedTips);
  return !creatable && !(stats && stats.changedFiles > 0) ? undefined : { creatable, stats };
}
