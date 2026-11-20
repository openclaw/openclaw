import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SandboxContext } from "../agents/sandbox/types.js";
import { withWorktreeGitConfig } from "../agents/worktrees/checkout-git-config.js";
import { requireGit, runGit } from "../agents/worktrees/git.js";
import { listDirectoryTreeStrict } from "../infra/directory-walk.js";

/** Where the conversation's own files live: inside its sandbox, or on the Gateway host. */
export type CarrySource =
  | { kind: "sandbox"; sandbox: SandboxContext }
  | { kind: "host"; workspaceDir: string };

/** A checkout's work, held in the project repository under a private ref until it is opened. */
type ImportedWork = {
  refName: string;
  /** The checkout's own commit; the new worktree branch starts here. */
  commit: string;
  /** A transfer commit on `commit` whose tree is the checkout's working tree. */
  work: string;
  unsavedFiles: number;
};

const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const TRANSFER_REF = "refs/openclaw/carry";
const TRANSFER_IDENTITY = {
  GIT_AUTHOR_NAME: "OpenClaw",
  GIT_AUTHOR_EMAIL: "openclaw@localhost",
  GIT_COMMITTER_NAME: "OpenClaw",
  GIT_COMMITTER_EMAIL: "openclaw@localhost",
};

// The checkout belongs to the agent, so its Git config, hooks and filters never run on
// the host. In a sandbox this script runs as the agent; on the host the same steps run
// in OpenClaw's trusted-config view. Unsaved changes travel as a commit on HEAD whose
// tree is the working tree, built in a private index and ref that are removed on exit.
// Accepted edge case: a highly compressed bundle can expand well past its byte size on
// checkout; the sandbox output cap bounds only the transfer.
const SANDBOX_BUNDLE = String.raw`set -eu
export GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0
git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
cd "$1" 2>/dev/null || exit 75
test "$(git rev-parse --show-toplevel 2>/dev/null)" = "$(pwd -P)" || exit 75
git rev-parse --verify -q 'HEAD^{commit}' >/dev/null || exit 75
shift
set --
for base in $BASES; do
  if git cat-file -e "$base^{commit}" 2>/dev/null; then
    set -- "$@" "^$base"
  fi
done
test "$#" -gt 0 || exit 76
dir=$(mktemp -d)
trap 'git update-ref -d ${TRANSFER_REF} 2>/dev/null || true; rm -rf "$dir"' EXIT
export GIT_INDEX_FILE="$dir/index"
git read-tree HEAD
git add -A
tree=$(git write-tree)
work=$(GIT_AUTHOR_NAME=OpenClaw GIT_AUTHOR_EMAIL=openclaw@localhost \
  GIT_COMMITTER_NAME=OpenClaw GIT_COMMITTER_EMAIL=openclaw@localhost \
  git commit-tree --no-gpg-sign -p HEAD -m "Unsaved work" "$tree")
git update-ref ${TRANSFER_REF} "$work"
git bundle create - ${TRANSFER_REF} "$@"
`;

const notCheckout = (checkout: string) =>
  new Error(
    `${checkout} is not a Git checkout with a commit in this conversation's workspace; nothing was moved.`,
  );
const unrelated = (checkout: string) =>
  new Error(`${checkout} shares no history with this project; nothing was moved.`);

function checkoutRelativePath(checkout: string): string {
  const normalized = path.posix.normalize(checkout.replaceAll("\\", "/")).replace(/\/+$/u, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized.includes("\0") ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(
      `Checkout ${JSON.stringify(checkout)} must be a folder inside this conversation's workspace; nothing was moved.`,
    );
  }
  return normalized;
}

async function bundleInSandbox(
  sandbox: SandboxContext,
  checkout: string,
  bases: string[],
  bundlePath: string,
  signal?: AbortSignal,
) {
  const bundle = await sandbox.backend!.runShellCommand({
    // Bases are host-selected commit IDs, never paths or options.
    script: `BASES=${JSON.stringify(bases.join(" "))}\n${SANDBOX_BUNDLE}`,
    args: [path.posix.join(sandbox.containerWorkdir, checkout)],
    allowFailure: true,
    signal,
  });
  if (bundle.code === 75) {
    throw notCheckout(checkout);
  }
  if (bundle.code === 76) {
    throw unrelated(checkout);
  }
  if (bundle.code !== 0 || bundle.stdout.length === 0) {
    throw new Error(`The work in ${checkout} could not be read; nothing was moved.`);
  }
  await fs.writeFile(bundlePath, bundle.stdout);
}

/**
 * On the host a checkout's Git data must be the conversation's own: a `.git` file,
 * alternates or a symlink inside the Git data could otherwise point Git at any
 * repository the Gateway user can read. Git never creates symlinks in its own data,
 * so ordinary clones and linked worktrees pass.
 */
async function ownsGitData(directory: string, root: string, guard: { signal?: AbortSignal }) {
  const [gitDir, commonDir] = await Promise.all([
    requireGit(directory, ["rev-parse", "--absolute-git-dir"], guard),
    requireGit(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"], guard),
  ]);
  for (const dir of new Set([gitDir, commonDir])) {
    const real = await fs.realpath(dir);
    const relative = path.relative(root, real);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return false;
    }
    // Git data too large or unreadable to walk cannot be shown to be its own.
    const entries = await listDirectoryTreeStrict(real).catch(() => undefined);
    if (!entries || entries.some(({ dirent }) => dirent.isSymbolicLink())) {
      return false;
    }
  }
  const alternates = await fs
    .stat(path.join(commonDir, "objects", "info", "alternates"))
    .catch(() => undefined);
  return !alternates;
}

/**
 * The host variant of the sandbox script. withWorktreeGitConfig replaces the checkout's
 * repository, global and system config with a trusted layout-only config for content
 * commands; runGit pins hooks and fsmonitor off for every command, including the
 * ref updates that keep the checkout's real metadata.
 */
async function bundleOnHost(
  workspaceDir: string,
  checkout: string,
  bases: string[],
  bundlePath: string,
  guard: { signal?: AbortSignal; beforeRun: () => void },
) {
  const [root, directory] = await Promise.all([
    fs.realpath(workspaceDir),
    fs.realpath(path.join(workspaceDir, checkout)).catch(() => undefined),
  ]);
  const relative = directory && path.relative(root, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw notCheckout(checkout);
  }
  const topLevel = await runGit(directory, ["rev-parse", "--show-toplevel"], guard);
  if (topLevel.code !== 0 || (await fs.realpath(topLevel.stdout.trim())) !== directory) {
    throw notCheckout(checkout);
  }
  if (!(await ownsGitData(directory, root, guard))) {
    throw new Error(
      `${checkout} keeps Git data outside this conversation's workspace, or too large or unreadable to check; nothing was moved.`,
    );
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-carry-index-"));
  try {
    await withWorktreeGitConfig(directory, true, guard, async (git) => {
      const head = await git.run(directory, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
      if (head.code !== 0) {
        throw notCheckout(checkout);
      }
      const exclusions: string[] = [];
      for (const base of bases) {
        const present = await git.run(directory, ["cat-file", "-e", `${base}^{commit}`]);
        if (present.code === 0) {
          exclusions.push(`^${base}`);
        }
      }
      if (exclusions.length === 0) {
        throw unrelated(checkout);
      }
      const env = { ...TRANSFER_IDENTITY, GIT_INDEX_FILE: path.join(temporary, "index") };
      await git.require(directory, ["read-tree", "HEAD"], { env });
      await git.require(directory, ["add", "-A"], { env });
      const tree = await git.require(directory, ["write-tree"], { env });
      const work = await git.require(
        directory,
        ["commit-tree", "-p", "HEAD", "-m", "Unsaved work", tree],
        { env },
      );
      await git.require(directory, ["update-ref", TRANSFER_REF, work]);
      try {
        await git.require(directory, ["bundle", "create", bundlePath, TRANSFER_REF, ...exclusions]);
      } finally {
        await git.run(directory, ["update-ref", "-d", TRANSFER_REF]);
      }
    });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

/**
 * Bundle a checkout's commits and unsaved changes where its files live, and fetch them
 * into the project repository under `refName`. The ref keeps the work until the session
 * opens the project; deleteCarryRef removes it.
 */
export async function importCarriedWork(params: {
  source: CarrySource;
  checkout: string;
  projectRoot: string;
  refName: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<ImportedWork> {
  const { projectRoot, refName, signal, source } = params;
  const checkout = checkoutRelativePath(params.checkout);
  const guard = { signal, beforeRun: params.assertCurrent };
  // Bundle only commits the project lacks; without a shared base the work is unrelated.
  const bases = (
    await requireGit(
      projectRoot,
      ["for-each-ref", "--count=200", "--format=%(objectname)", "refs/heads", "refs/remotes"],
      guard,
    )
  )
    .split("\n")
    .filter((base) => COMMIT_PATTERN.test(base));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-carry-"));
  try {
    const bundlePath = path.join(temporary, "work.bundle");
    if (source.kind === "sandbox") {
      await bundleInSandbox(source.sandbox, checkout, bases, bundlePath, signal);
    } else {
      await bundleOnHost(source.workspaceDir, checkout, bases, bundlePath, guard);
    }
    params.assertCurrent();
    await requireGit(
      projectRoot,
      ["fetch", "--no-tags", "--no-write-fetch-head", bundlePath, `${TRANSFER_REF}:${refName}`],
      guard,
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  // The transfer commit has exactly one parent: the checkout's own commit.
  const [work, commit, extra] = (
    await requireGit(projectRoot, ["rev-list", "--parents", "-n", "1", refName], guard)
  ).split(" ");
  if (!work || !commit || extra !== undefined) {
    await deleteCarryRef(projectRoot, refName);
    throw new Error(`The work in ${checkout} could not be read; nothing was moved.`);
  }
  const changed = await requireGit(
    projectRoot,
    ["diff", "--no-renames", "--name-only", "-z", commit, work],
    guard,
  );
  return { refName, work, commit, unsavedFiles: changed.split("\0").filter(Boolean).length };
}

export async function deleteCarryRef(projectRoot: string, refName: string): Promise<void> {
  await runGit(projectRoot, ["update-ref", "-d", refName]);
}

/** Lay carried unsaved changes over a new worktree, leaving them unsaved. */
export async function applyUnsavedWork(work: string, worktreePath: string) {
  // Git writes the files: it replaces links instead of following them. Carried
  // attributes may name filters, so only trusted layout config is in effect.
  await withWorktreeGitConfig(worktreePath, true, {}, (git) =>
    git.require(worktreePath, ["restore", `--source=${work}`, "--worktree", "--", "."]),
  );
}

// Lists Git checkouts one or two folders deep as NUL-separated path and origin URL pairs.
const SANDBOX_LIST = String.raw`set -u
export GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0
git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
cd "$1" || exit 0
for marker in */.git */*/.git; do
  dir=$(dirname "$marker")
  test "$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" = "$(cd "$dir" && pwd -P)" || continue
  git -C "$dir" rev-parse --verify -q 'HEAD^{commit}' >/dev/null || continue
  origin=$(git -C "$dir" config --get remote.origin.url || true)
  printf '%s\0%s\0' "$dir" "$origin"
done
`;

/** A folder with a commit to carry, and the origin that matches it to a project. */
type CarryCheckout = { path: string; originUrl: string };

const MAX_LISTED_CHECKOUTS = 32;

async function listOnHost(workspaceDir: string, signal?: AbortSignal): Promise<CarryCheckout[]> {
  const root = await fs.realpath(workspaceDir);
  // Real folders only: a symlinked folder could name host files outside the workspace.
  const folders = async (relative: string) =>
    (await fs.readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []))
      .filter((child) => child.isDirectory() && !child.name.startsWith("."))
      .map((child) => path.join(relative, child.name));
  const candidates: string[] = [];
  for (const first of await folders("")) {
    candidates.push(first, ...(await folders(first)));
  }
  const checkouts: CarryCheckout[] = [];
  for (const relative of candidates) {
    if (checkouts.length >= MAX_LISTED_CHECKOUTS) {
      break;
    }
    const directory = path.join(root, relative);
    const marker = await fs.lstat(path.join(directory, ".git")).catch(() => undefined);
    const topLevel =
      marker && (await runGit(directory, ["rev-parse", "--show-toplevel"], { signal }));
    if (
      !topLevel ||
      topLevel.code !== 0 ||
      topLevel.stdout.trim() !== directory ||
      !(await ownsGitData(directory, root, { signal }))
    ) {
      continue;
    }
    const gitDir = await requireGit(directory, ["rev-parse", "--absolute-git-dir"], { signal });
    // Reading one config file as data runs nothing from it.
    const origin = await runGit(
      directory,
      ["config", "--file", path.join(gitDir, "config"), "--get", "remote.origin.url"],
      { signal },
    );
    const head = await runGit(directory, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], {
      signal,
    });
    if (head.code === 0) {
      checkouts.push({
        path: relative.split(path.sep).join("/"),
        originUrl: origin.code === 0 ? origin.stdout.trim() : "",
      });
    }
  }
  return checkouts;
}

/** Checkouts in the conversation's workspace, read where its files live. */
export async function listCarryCheckouts(
  source: CarrySource,
  signal?: AbortSignal,
): Promise<CarryCheckout[]> {
  if (source.kind === "host") {
    return await listOnHost(source.workspaceDir, signal);
  }
  const listed = await source.sandbox.backend!.runShellCommand({
    script: SANDBOX_LIST,
    args: [source.sandbox.containerWorkdir],
    allowFailure: true,
    signal,
  });
  const fields = listed.code === 0 ? listed.stdout.toString().split("\0") : [];
  const checkouts: CarryCheckout[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    checkouts.push({ path: fields[index]!, originUrl: fields[index + 1]! });
  }
  return checkouts.slice(0, MAX_LISTED_CHECKOUTS);
}
