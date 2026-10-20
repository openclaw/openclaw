import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { readRegularFile } from "@openclaw/fs-safe/advanced";
import type { DiffReadTiming } from "../infra/diff-read-timing.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { GitCommandTimeoutError, requireGitCommandOutput } from "../infra/git-exec.js";
import type { GitReadOperations } from "../infra/git-read-operations.js";
import {
  readGitHead,
  readGitMetadataDirectories,
  readGitMetadataPrefix,
  readGitRefs,
} from "../infra/git-root.js";
import {
  canReadGitFilesystemRefs,
  gitFilesystemEnvironmentRevision,
} from "../infra/git-worker-context.js";
import type { GitWorkerOperations } from "../infra/git-worker-contract.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
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
): Promise<string | null> {
  if (!canReadGitFilesystemRefs()) {
    return null;
  }
  try {
    if (scope === "diff") {
      return await readCheckoutDiffRevision(root, diffPaths, summaryOnly, timing);
    }
    const head = readGitHead(root, { maxDepth: 1 });
    const checkout = readCheckoutHead(root);
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
          ...fs
            .readdirSync(replacements, { recursive: true, encoding: "utf8" })
            .map((name) => nodePath.join(replacements, name)),
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
    return JSON.stringify([
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
    ]);
  } catch {
    return null;
  }
}

type GitInstallationFiles = { revision: string; config: string[]; attributes: string[] };
// One installation per worker; environment or executable replacement retires its discovery.
let gitInstallationFiles:
  | { key: string; promise: Promise<GitInstallationFiles | null> }
  | undefined;
// Worker retirement drops these bounded observations of externally owned checkouts.
const smallDiffRevisions = new Map<string, { fingerprint: string; revision: string }>();

async function readGitInstallationFiles(
  root: string,
  environment: string,
): Promise<GitInstallationFiles | null> {
  const executable = resolveExecutablePath("git", { cwd: root, useCache: false });
  if (!executable) {
    return null;
  }
  const binary = fs.realpathSync(executable);
  const stat = fs.statSync(binary, { bigint: true });
  const key = JSON.stringify([
    environment,
    binary,
    ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String),
  ]);
  if (gitInstallationFiles?.key !== key) {
    const promise = Promise.allSettled(
      ["GIT_CONFIG_SYSTEM", "GIT_ATTR_SYSTEM"].map(async (variable) => {
        const result = await runPullRequestGit(root, ["var", variable], {
          maxOutputBytes: 64 * 1024,
          terminateOnOutputLimit: true,
        });
        // Known disabled paths have no diagnostics; older Git reports unknown variables.
        if (
          result.termination === "exit" &&
          result.code === 1 &&
          !result.stdout.trim() &&
          !result.stderr.trim()
        ) {
          return [];
        }
        const paths = result.stdout.replace(/\n$/, "").split("\n").filter(Boolean);
        return result.termination === "exit" &&
          result.code === 0 &&
          !result.stdoutTruncatedBytes &&
          paths.every((file) => nodePath.isAbsolute(file))
          ? paths
          : null;
      }),
    )
      .then((probes) => {
        const [config, attributes] = probes.map((probe) => {
          if (probe.status === "rejected") {
            throw probe.reason;
          }
          return probe.value;
        });
        return config && attributes ? { revision: key, config, attributes } : null;
      })
      .catch((error: unknown) => {
        if (gitInstallationFiles?.key === key) {
          gitInstallationFiles = undefined;
        }
        throw error;
      });
    gitInstallationFiles = { key, promise };
  }
  return await gitInstallationFiles.promise;
}

/** Git owns ignored paths and index refreshes; observe only its changed-file inventory. */
async function readCheckoutDiffRevision(
  root: string,
  previousPaths: string[] = [],
  summaryOnly = false,
  timing?: DiffReadTiming,
): Promise<string | null> {
  const environment = createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(process.env)
          .filter(([key]) => /^(GIT_|HOME$|XDG_CONFIG_HOME$|PATH$|SUDO_UID$)/i.test(key))
          .toSorted(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex");
  // Reused workers may have an older environment; Windows path translation retains native reads.
  if (
    environment !== gitFilesystemEnvironmentRevision() ||
    process.platform === "win32" ||
    fs.realpathSync(root) !== root
  ) {
    return null;
  }
  const directories = readGitMetadataDirectories(root);
  if (!directories) {
    return null;
  }
  const { gitDir, commonDir } = directories;
  const hash = createHash("sha256").update(environment);
  let remaining = 10_000;
  const oversized = () => {
    if (timing) {
      timing.revisionUnavailableReason = "oversized";
    }
    throw new Error("Checkout diff revision exceeds its metadata budget");
  };
  const readStat = (file: string) => {
    if (--remaining < 0) {
      oversized();
    }
    return fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  };
  const observe = (file: string, allowSymlink = false, target = hash, identityOnly = false) => {
    const stat = readStat(file);
    if (stat?.isSymbolicLink() && !allowSymlink) {
      throw new Error("Indirect Git metadata requires a fresh diff");
    }
    target.update(
      JSON.stringify([
        file,
        ...(stat
          ? (identityOnly && stat.isDirectory()
              ? [stat.dev, stat.ino]
              : [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs]
            ).map(String)
          : []),
      ]),
    );
    return stat;
  };
  const entries = (directory: string) => {
    const handle = fs.opendirSync(directory);
    const children: fs.Dirent[] = [];
    try {
      for (let entry; (entry = handle.readSync());) {
        if (children.length >= remaining) {
          oversized();
        }
        children.push(entry);
      }
    } finally {
      handle.closeSync();
    }
    return children;
  };
  const walk = (directory: string) => {
    if (!observe(directory)?.isDirectory()) {
      return;
    }
    // Inventory first: oversized trees cannot yield a revision, so do not stat/hash their files.
    const pendingDirectories = [directory];
    const files: string[] = [];
    for (const parent of pendingDirectories) {
      for (const entry of entries(parent)) {
        const file = nodePath.join(parent, entry.name);
        if (files.push(file) > remaining) {
          oversized();
        }
        if (entry.isDirectory()) {
          pendingDirectories.push(file);
        }
      }
    }
    for (const file of files.toSorted()) {
      observe(file);
    }
  };
  for (const file of directories.paths) {
    // Index lock/rename and ignored output change directory stamps, not identity.
    observe(file, false, hash, true);
  }
  const home = process.env.HOME ?? os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME ?? nodePath.join(home, ".config");
  const installation = await readGitInstallationFiles(root, environment);
  if (!installation) {
    return null;
  }
  hash.update(installation.revision);
  const configFiles = [
    nodePath.join(commonDir, "config"),
    nodePath.join(gitDir, "config.worktree"),
    ...(process.env.GIT_CONFIG_GLOBAL
      ? [process.env.GIT_CONFIG_GLOBAL]
      : [nodePath.join(home, ".gitconfig"), nodePath.join(xdg, "git/config")]),
    ...installation.config,
  ];
  for (const file of configFiles) {
    if (!nodePath.isAbsolute(file)) {
      return null;
    }
    if (file === os.devNull) {
      continue;
    }
    const stat = observe(file);
    if (
      stat &&
      (!stat.isFile() ||
        stat.size > 65_536n ||
        /\[\s*(?:include|filter)|(?:attributesfile|excludesfile|worktree|orderfile)\s*=/i.test(
          readGitMetadataPrefix(file, 65_536),
        ))
    ) {
      return null;
    }
  }
  for (const file of ["attributes", "ignore"]) {
    observe(nodePath.join(xdg, "git", file));
  }
  for (const file of installation.attributes) {
    observe(file);
  }
  for (const directory of new Set([gitDir, commonDir])) {
    if (observe(nodePath.join(directory, "reftable"))) {
      return null;
    }
    for (const file of ["commondir", "packed-refs", "shallow"]) {
      observe(nodePath.join(directory, file));
    }
    for (const child of ["refs", "info"]) {
      walk(nodePath.join(directory, child));
    }
  }
  // Object IDs are immutable; directory stamps capture newly hydrated loose objects/packs.
  const objects = nodePath.join(commonDir, "objects");
  if (observe(nodePath.join(objects, "info/alternates"))) {
    return null;
  }
  if (observe(objects)?.isDirectory()) {
    for (const child of entries(objects)
      .map((entry) => entry.name)
      .toSorted()) {
      observe(nodePath.join(objects, child));
    }
  }
  // Preserve the zero-Git path for small idle checkouts. Any filesystem churn
  // revalidates through Git; only Git's semantic revision invalidates the diff.
  const semanticBudget = remaining;
  const fingerprint = (() => {
    try {
      const files = [root];
      const pending = [root];
      for (const parent of pending) {
        for (const entry of entries(parent)) {
          if (entry.name === ".git") {
            if (parent !== root) {
              return null;
            }
            continue;
          }
          const file = nodePath.join(parent, entry.name);
          if (files.push(file) > remaining - 2) {
            oversized();
          }
          if (entry.isDirectory()) {
            pending.push(file);
          }
        }
      }
      const stamp = hash.copy();
      observe(nodePath.join(gitDir, "HEAD"), false, stamp);
      observe(nodePath.join(gitDir, "index"), false, stamp);
      for (const file of files.toSorted()) {
        observe(file, true, stamp);
      }
      return stamp.digest("hex");
    } catch {
      return null; // Optional memo admission must not disable the semantic revision.
    }
  })();
  remaining = semanticBudget;
  // Oversized summaries already allow a 10-second fallback. A full status scan
  // on each poll costs more than that retained summary; full diffs require freshness.
  if (!fingerprint && summaryOnly) {
    return null;
  }
  const memoKey = JSON.stringify([root, environment, summaryOnly, previousPaths.toSorted()]);
  const memo = smallDiffRevisions.get(memoKey);
  smallDiffRevisions.delete(memoKey);
  if (fingerprint && memo?.fingerprint === fingerprint) {
    smallDiffRevisions.set(memoKey, memo);
    return memo.revision;
  }
  const status = await runPullRequestGit(
    root,
    [
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "--branch",
      "--no-ahead-behind",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "--no-renames",
      "-z",
    ],
    { maxOutputBytes: 1024 * 1024, terminateOnOutputLimit: true },
  );
  if (status.stdoutTruncatedBytes || status.outputLimitExceeded) {
    oversized();
  }
  if (status.code !== 0 || status.termination !== "exit" || status.stdout.includes("\uFFFD")) {
    return null;
  }
  const head = createHash("sha256");
  const index = createHash("sha256");
  const untrackedSet = createHash("sha256");
  const worktreeMtime = createHash("sha256");
  const paths = new Set<string>();
  for (const record of status.stdout.split("\0").filter(Boolean)) {
    if (record.startsWith("# ")) {
      head.update(record).update("\0");
      continue;
    }
    let file: string;
    if (record.startsWith("? ")) {
      file = record.slice(2);
      untrackedSet.update(file).update("\0");
    } else {
      // Porcelain v2 preserves index object/mode identity without index stat-cache bytes.
      const entry = /^1 (..) (....) (\d+) (\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) (.*)$/su.exec(record);
      if (!entry || entry[2] !== "N...") {
        return null; // Conflicts and dirty nested repositories retain fresh Git reads.
      }
      file = entry[8]!;
      if (entry[1]![0] !== ".") {
        index.update(JSON.stringify([file, entry[1]![0], entry[4], entry[7]]));
      }
      worktreeMtime.update(JSON.stringify([file, entry[1]![1], entry[5]]));
    }
    paths.add(file);
    if (observe(nodePath.join(root, file), true, worktreeMtime)?.isDirectory()) {
      return null;
    }
  }
  // Clean committed previews still depend on file type and hardlink eligibility.
  for (const file of previousPaths.toSorted()) {
    if (!paths.has(file)) {
      const stat = readStat(nodePath.join(root, file));
      hash.update(JSON.stringify([file, stat?.mode.toString(), stat?.nlink.toString()]));
      paths.add(file);
    }
  }
  // Displayed paths also depend on ignored attribute files in parent directories.
  const attributes = new Set([nodePath.join(root, ".gitattributes")]);
  for (const file of paths) {
    let directory = nodePath.dirname(nodePath.join(root, file));
    while (directory !== root && directory.startsWith(`${root}${nodePath.sep}`)) {
      attributes.add(nodePath.join(directory, ".gitattributes"));
      directory = nodePath.dirname(directory);
    }
  }
  for (const file of [...attributes].toSorted()) {
    observe(file);
  }
  const revision = JSON.stringify({
    head: head.digest("hex"),
    index: index.digest("hex"),
    untrackedSet: untrackedSet.digest("hex"),
    worktreeMtime: worktreeMtime.digest("hex"),
    metadata: hash.digest("hex"),
  });
  if (fingerprint) {
    smallDiffRevisions.set(memoKey, { fingerprint, revision });
    pruneMapToMaxSize(smallDiffRevisions, 64);
  }
  return revision;
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
    for (const byte of body) {
      if (byte === 10) {
        lines += 1;
      }
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
  const paths = listing?.code === 0 ? listing.stdout.split("\0").filter(Boolean) : [];
  let additions = 0;
  for (const filePath of paths.slice(0, MAX_UNTRACKED_STAT_FILES)) {
    additions += await untrackedFileAdditions(root, filePath);
  }
  return { additions, files: paths.length };
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
