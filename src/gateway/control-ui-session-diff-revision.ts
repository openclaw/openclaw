import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { unavailableDiffRevision, type DiffReadTiming } from "../infra/diff-read-timing.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import type { GitReadOperations } from "../infra/git-read-operations.js";
import {
  findGitRoot,
  readGitMetadataDirectories,
  readGitMetadataPrefix,
} from "../infra/git-root.js";
import { gitFilesystemEnvironmentRevision } from "../infra/git-worker-context.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { gitOutput, runPullRequestGit } from "./control-ui-session-prs-landing.js";

type GitInstallationFiles = { revision: string; config: string[]; attributes: string[] };
// One installation per worker; environment or executable replacement retires its discovery.
let gitInstallationFiles:
  | { key: string; promise: Promise<GitInstallationFiles | null> }
  | undefined;
// Worker retirement drops these bounded observations of externally owned checkouts.
const smallDiffRevisions = new Map<
  string,
  {
    fingerprint: string;
    revision: NonNullable<GitReadOperations["checkout.revision"]["output"]>;
  }
>();

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
export async function readCheckoutDiffRevision(
  cwd: string,
  previousPaths: string[] = [],
  summaryOnly = false,
  timing?: DiffReadTiming,
): Promise<GitReadOperations["checkout.revision"]["output"]> {
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
  if (environment !== gitFilesystemEnvironmentRevision()) {
    return unavailableDiffRevision(timing, "no-revision-environment");
  }
  if (process.platform === "win32") {
    return unavailableDiffRevision(timing, "no-revision-platform");
  }
  // Diff collection accepts nested/aliased cwd paths; validate the same physical checkout.
  const root = findGitRoot(fs.realpathSync(cwd));
  if (!root) {
    return unavailableDiffRevision(timing, "no-revision-metadata");
  }
  const directories = readGitMetadataDirectories(root);
  if (!directories) {
    return unavailableDiffRevision(timing, "no-revision-metadata");
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
      unavailableDiffRevision(timing, "no-revision-symlink");
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
    return unavailableDiffRevision(timing, "no-revision-git-installation");
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
  let hasExcludesFile = false;
  for (const file of configFiles) {
    if (!nodePath.isAbsolute(file)) {
      return unavailableDiffRevision(timing, "no-revision-config");
    }
    if (file === os.devNull) {
      continue;
    }
    const stat = observe(file);
    if (!stat) {
      continue;
    }
    if (!stat.isFile() || stat.size > 1_048_576n) {
      return unavailableDiffRevision(timing, "no-revision-config");
    }
    const config = readGitMetadataPrefix(file, Number(stat.size));
    if (/\[\s*(?:include|filter)|(?:attributesfile|worktree|orderfile)\s*=/i.test(config)) {
      return unavailableDiffRevision(timing, "no-revision-config");
    }
    hasExcludesFile ||= /excludesfile\s*=/i.test(config);
  }
  if (hasExcludesFile) {
    // Git owns precedence, quoting and ~/ expansion; the external ignore file
    // must invalidate both the filesystem memo and the semantic revision.
    const excludes = await runPullRequestGit(root, [
      "config",
      "--null",
      "--path",
      "--get",
      "core.excludesFile",
    ]);
    if (excludes.code !== 0 || excludes.termination !== "exit" || excludes.stdoutTruncatedBytes) {
      return unavailableDiffRevision(timing, "no-revision-config");
    }
    const file = excludes.stdout.replace(/\0$/, "");
    if (file) {
      observe(nodePath.resolve(root, file));
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
      return unavailableDiffRevision(timing, "no-revision-reftable");
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
    return unavailableDiffRevision(timing, "no-revision-alternates");
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
      let hasNestedRepository = false;
      for (const parent of pending) {
        const children = entries(parent);
        if (parent !== root && children.some((entry) => entry.name === ".git")) {
          hasNestedRepository = true;
          continue;
        }
        for (const entry of children) {
          if (entry.name === ".git") {
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
      // Keep the parent census budget, but let Git own opaque repositories' state.
      if (hasNestedRepository) {
        return undefined;
      }
      const stamp = hash.copy();
      observe(nodePath.join(gitDir, "HEAD"), false, stamp);
      observe(nodePath.join(gitDir, "index"), false, stamp);
      for (const file of files.toSorted()) {
        observe(file, true, stamp);
      }
      return stamp.digest("hex");
    } catch (error) {
      // Optional memo admission must not disable the semantic revision.
      return unavailableDiffRevision(timing, undefined, error);
    }
  })();
  remaining = semanticBudget;
  // Oversized summaries already allow a 10-second fallback. A full status scan
  // on each poll costs more than that retained summary; full diffs require freshness.
  if (fingerprint === null && summaryOnly) {
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
    return unavailableDiffRevision(timing, "no-revision-status");
  }
  const head = createHash("sha256");
  const index = createHash("sha256");
  const untrackedSet = createHash("sha256");
  const worktreeMtime = createHash("sha256");
  const paths = new Set<string>();
  let cleanHead: string | undefined;
  for (const record of status.stdout.split("\0").filter(Boolean)) {
    if (record.startsWith("# ")) {
      head.update(record).update("\0");
      if (/^# branch\.oid (?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(record)) {
        cleanHead = record.slice("# branch.oid ".length);
      }
      continue;
    }
    let file: string;
    if (record.startsWith("? ")) {
      file = record.slice(2);
      untrackedSet.update(file).update("\0");
    } else {
      // Porcelain v2 preserves index object/mode identity without index stat-cache bytes.
      const entry = /^1 (..) (....) (\d+) (\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) (.*)$/su.exec(record);
      if (!entry) {
        return unavailableDiffRevision(timing, "no-revision-unmerged");
      }
      file = entry[8]!;
      if (entry[2] !== "N...") {
        // The changed-commit flag alone cannot distinguish two non-index commits.
        const submoduleHead = await gitOutput(nodePath.join(root, file), [
          "rev-parse",
          "--verify",
          "HEAD",
        ]);
        if (!submoduleHead) {
          return unavailableDiffRevision(timing, "no-revision-submodule");
        }
        worktreeMtime.update(submoduleHead);
      }
      if (entry[1]![0] !== ".") {
        index.update(JSON.stringify([file, entry[1]![0], entry[4], entry[7]]));
      }
      worktreeMtime.update(JSON.stringify([file, entry[1]![1], entry[2], entry[5]]));
    }
    paths.add(file);
    // Untracked repositories are opaque directory rows; gitlinks expose their
    // dirtiness above. Neither publishes nested working-tree file contents.
    observe(nodePath.join(root, file), true, worktreeMtime);
  }
  const cleanWorktree = paths.size === 0 && cleanHead ? { root, head: cleanHead } : undefined;
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
  const revision = {
    key: JSON.stringify({
      head: head.digest("hex"),
      index: index.digest("hex"),
      untrackedSet: untrackedSet.digest("hex"),
      worktreeMtime: worktreeMtime.digest("hex"),
      metadata: hash.digest("hex"),
    }),
    ...(cleanWorktree ? { cleanWorktree } : {}),
  };
  if (fingerprint) {
    smallDiffRevisions.set(memoKey, { fingerprint, revision });
    pruneMapToMaxSize(smallDiffRevisions, 64);
  }
  return revision;
}
