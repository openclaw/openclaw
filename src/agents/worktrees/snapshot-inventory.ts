import { constants, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isMissingPathError } from "../../infra/errors.js";
import { root as fsRoot } from "../../infra/fs-safe.js";
import { normalizeGitPathForFilesystem } from "../../infra/git-exec.js";
import { requestGitWorkerEffect } from "../../infra/git-worker-context.js";
import {
  createStagedInputPathMatcher,
  stagedInputPathDirectory,
} from "../../media/staged-inputs.js";
import {
  checkoutPathFromGitBytes,
  containsGitMarker,
  gitPathKey,
  parseGitIndexPaths,
  parseGitTreePaths,
  rawPathExists,
  splitNullBuffer,
  type GitIndexPath,
  type GitTreePath,
} from "./git-path-inventory.js";
import type { GitWorktreeOperations } from "./git-worktree-operations.js";
import { commandError, requireGit, requireGitBuffer, runGit } from "./git.js";
import {
  captureExactState,
  exactSnapshotPrefix,
  writeExactStateCommit,
} from "./snapshot-exact-state.js";

type SnapshotIndexEnvironment = NodeJS.ProcessEnv & { GIT_INDEX_FILE: string };

type SnapshotInput = GitWorktreeOperations["worktree.snapshot"]["input"];
type SnapshotInventory = {
  head: string;
  headPaths: GitTreePath[];
  paths: Map<string, Buffer>;
};

const assertCurrent = () =>
  requestGitWorkerEffect<"worktree.assert-current">({ type: "worktree.assert-current", input: {} });

// @types/node omits opendir's buffer encoding and declares only string names.
function openRawDirectory(directoryPath: string | Buffer) {
  // SAFETY: Node accepts buffer encoding; the consumer validates names before use.
  const openDirectory = fs.opendir as (
    path: string | Buffer,
    options: { encoding: BufferEncoding | "buffer" },
  ) => Promise<AsyncIterable<Dirent<string | Buffer>>>;
  return openDirectory(directoryPath, { encoding: "buffer" });
}

async function listCollapsedOtherPaths(checkoutPath: string, ignored: boolean): Promise<Buffer[]> {
  // --directory collapses whole untracked/ignored trees to one entry each, so the
  // Git output stays bounded by top-level entries instead of every dependency file.
  return splitNullBuffer(
    await requireGitBuffer(checkoutPath, [
      "ls-files",
      "-z",
      "--others",
      ...(ignored ? ["--ignored"] : []),
      "--exclude-standard",
      "--directory",
    ]),
  );
}

async function walkCollapsedPaths(
  checkoutPath: string,
  entries: readonly Buffer[],
  options: { visitFile?: (entry: Buffer) => Promise<void>; skip?: ReadonlySet<string> },
): Promise<boolean> {
  const visitDirectory = async (relative: Buffer): Promise<boolean> => {
    if (
      await rawPathExists(
        checkoutPathFromGitBytes(checkoutPath, Buffer.concat([relative, Buffer.from("/.git")])),
      )
    ) {
      return true;
    }
    // Buffer names preserve bytes through Node's lstat fallback for unknown entry
    // types. opendir batches entries and closes the handle even on early retention.
    const directory = await openRawDirectory(checkoutPathFromGitBytes(checkoutPath, relative));
    for await (const entry of directory) {
      if (!Buffer.isBuffer(entry.name)) {
        throw new Error("Expected raw directory-entry bytes");
      }
      const child = Buffer.concat([relative, Buffer.from("/"), entry.name]);
      if (options.skip?.has(gitPathKey(child))) {
        continue;
      }
      if (entry.isDirectory()) {
        if (await visitDirectory(child)) {
          return true;
        }
      } else {
        // Never follow symlinks; only ordinary Git-style leaf paths enter the snapshot.
        await options.visitFile?.(child);
      }
    }
    return false;
  };
  for (const entry of entries) {
    if (entry.at(-1) === 47) {
      if (await visitDirectory(entry.subarray(0, -1))) {
        return true;
      }
    } else {
      await options.visitFile?.(entry);
    }
  }
  return false;
}

/** Index entries whose flags make Git skip its worktree comparison for that path. */
function unstattedIndexPaths(index: readonly GitIndexPath[]): Buffer[] {
  return index
    .filter((entry) => entry.assumeUnchanged || entry.skipWorktree)
    .map((entry) => entry.path);
}

/**
 * Inspect untracked and ignored paths without buffering every filename through Git.
 * Resolves true when a nested repository marker is found; ignored paths nested in
 * untracked trees stay out of the untracked visit so ignore semantics are preserved.
 * `unstattedIndexPaths` carries the index entries Git will not compare against the
 * filesystem, whose replacements only a direct stat can discover.
 */
async function inspectOtherPaths(
  checkoutPath: string,
  options: {
    unstattedIndexPaths?: readonly Buffer[];
    untracked?: (entry: Buffer) => Promise<void>;
    ignored?: (entry: Buffer) => Promise<void>;
  } = {},
): Promise<boolean> {
  const untracked = await listCollapsedOtherPaths(checkoutPath, false);
  // Git omits a directory that replaced an indexed file from the collapsed listing
  // because the index still holds that path. diff-files reports such entries as deleted
  // or, for a conflict, unmerged; it deliberately skips assume-unchanged and
  // skip-worktree entries, so those are stat-checked directly. Every candidate set stays
  // small: worktree deletions and conflicts, plus only manually flagged paths.
  const candidates = new Map<string, Buffer>();
  for (const entry of [
    ...splitNullBuffer(
      await requireGitBuffer(checkoutPath, ["diff-files", "-z", "--name-only", "--diff-filter=DU"]),
    ),
    ...(options.unstattedIndexPaths ?? []),
  ]) {
    candidates.set(gitPathKey(entry), entry);
  }
  const replaced = [...candidates.values()];
  for (let offset = 0; offset < replaced.length; offset += 64) {
    const batch = replaced.slice(offset, offset + 64);
    const stats = await Promise.allSettled(
      batch.map((entry) => fs.lstat(checkoutPathFromGitBytes(checkoutPath, entry))),
    );
    for (const [index, result] of stats.entries()) {
      if (result.status === "rejected") {
        if (!isMissingPathError(result.reason)) {
          throw result.reason;
        }
      } else if (result.value.isDirectory()) {
        untracked.push(Buffer.concat([batch[index]!, Buffer.from("/")]));
      }
    }
  }
  const ignored = await listCollapsedOtherPaths(checkoutPath, true);
  if (await containsGitMarker(checkoutPath, [...untracked, ...ignored])) {
    return true;
  }
  const ignoredKeys = new Set(
    ignored.map((entry) => gitPathKey(entry.at(-1) === 47 ? entry.subarray(0, -1) : entry)),
  );
  return (
    (await walkCollapsedPaths(checkoutPath, untracked, {
      visitFile: options.untracked,
      skip: ignoredKeys,
    })) || (await walkCollapsedPaths(checkoutPath, ignored, { visitFile: options.ignored }))
  );
}

async function rawDirectoryExists(target: string | Buffer): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function collectSnapshotInventory(input: SnapshotInput): Promise<SnapshotInventory> {
  const head = await requireGit(input.checkoutPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const headPaths = parseGitTreePaths(
    await requireGitBuffer(input.checkoutPath, ["ls-tree", "-r", "-z", head]),
  );
  const index = parseGitIndexPaths(
    await requireGitBuffer(input.checkoutPath, ["ls-files", "--stage", "-v", "-z"]),
  );
  const provisioned = new Set(
    input.provisionedPaths.map((entry) => gitPathKey(Buffer.from(entry))),
  );
  const paths = new Map<string, Buffer>();
  const add = (entry: Buffer) => {
    const key = gitPathKey(entry);
    if (!provisioned.has(key)) {
      paths.set(key, entry);
    }
  };
  const sparseConfig = await runGit(input.checkoutPath, [
    "config",
    "--bool",
    "core.sparseCheckout",
  ]);
  if (sparseConfig.code !== 0 && sparseConfig.code !== 1) {
    throw commandError("git config --bool core.sparseCheckout", sparseConfig);
  }
  const sparse = sparseConfig.code === 0 && sparseConfig.stdout.trim() === "true";
  const sourcePaths = new Set<string>();
  const sparseCandidates: Buffer[] = [];
  const headKeys = new Set(headPaths.map((entry) => gitPathKey(entry.path)));
  for (const entry of index) {
    sourcePaths.add(gitPathKey(entry.path));
    // A directory replacing an indexed path is no blob. HEAD paths still delete
    // cleanly against the snapshot index, but a conflicted path carries no stage 0
    // for Git to drop by name; its untracked children arrive through the listing.
    if (
      !headKeys.has(gitPathKey(entry.path)) &&
      (await rawDirectoryExists(checkoutPathFromGitBytes(input.checkoutPath, entry.path)))
    ) {
      continue;
    }
    if (
      !entry.skipWorktree ||
      (await rawPathExists(checkoutPathFromGitBytes(input.checkoutPath, entry.path))) ||
      !sparse
    ) {
      add(entry.path);
    } else {
      sparseCandidates.push(entry.path);
    }
  }
  if (sparseCandidates.length > 0) {
    const included = await requireGitBuffer(
      input.checkoutPath,
      ["sparse-checkout", "check-rules", "-z"],
      {
        input: Buffer.concat(sparseCandidates.flatMap((entry) => [entry, Buffer.from([0])])),
      },
    );
    for (const entry of splitNullBuffer(included)) {
      add(entry);
    }
  }
  // Index omissions are staged deletions; every remaining indexed path was already selected.
  for (const entry of headPaths) {
    if (!sourcePaths.has(gitPathKey(entry.path))) {
      add(entry.path);
    }
  }
  const isStagedInput = createStagedInputPathMatcher(await fsRoot(input.checkoutPath));
  const otherNested = await inspectOtherPaths(input.checkoutPath, {
    unstattedIndexPaths: unstattedIndexPaths(index),
    untracked: async (entry) => {
      add(entry);
    },
    ignored: async (entry) => {
      const relativePath = entry.toString("utf8");
      if (stagedInputPathDirectory(relativePath) && (await isStagedInput(relativePath))) {
        add(entry);
      }
    },
  });
  if (otherNested || (await containsGitMarker(input.checkoutPath, paths.values()))) {
    throw new Error("nested git repositories cannot be snapshotted losslessly");
  }
  return { head, headPaths, paths };
}

// These settings apply only to the private snapshot index. Cached entries must
// still detect mode/ctime changes, regardless of the checkout's performance policy.
const snapshotIndexArgs = [
  "-c",
  "core.splitIndex=false",
  "-c",
  "core.sparseCheckout=false",
  "-c",
  "index.sparse=false",
  "-c",
  "core.ignoreStat=false",
  "-c",
  "core.trustctime=true",
  "-c",
  "core.checkStat=default",
  ...(process.platform === "win32" ? [] : ["-c", "core.filemode=true"]),
];

async function seedSnapshotIndex(
  input: SnapshotInput,
  inventory: SnapshotInventory,
  indexEnv: SnapshotIndexEnvironment,
): Promise<void> {
  const source = path.resolve(
    input.checkoutPath,
    normalizeGitPathForFilesystem(
      await requireGit(input.checkoutPath, ["rev-parse", "--git-path", "index"]),
    ),
  );
  const destination = indexEnv.GIT_INDEX_FILE;
  try {
    const stat = await fs.stat(source);
    await fs.copyFile(source, destination, constants.COPYFILE_FICLONE);
    // A newly dated copy would make Git trust entries that were racy against the
    // original index. Round down rather than lose precision toward a newer time.
    const timestamp = Math.floor(stat.mtimeMs / 1000);
    await fs.utimes(destination, timestamp, timestamp);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  await requireGit(
    input.checkoutPath,
    [...snapshotIndexArgs, "read-tree", "--reset", inventory.head],
    {
      env: indexEnv,
    },
  );
  // Reset staged content to HEAD while retaining Git's matching stat entries.
  // Hidden flags belong to the live checkout, never to its lossless snapshot.
  const paths = Buffer.concat(
    inventory.headPaths.flatMap((entry) => [entry.path, Buffer.from([0])]),
  );
  for (const flag of ["--no-assume-unchanged", "--no-skip-worktree"]) {
    await requireGit(
      input.checkoutPath,
      [...snapshotIndexArgs, "update-index", flag, "-z", "--stdin"],
      {
        env: indexEnv,
        input: paths,
      },
    );
  }
}

async function prepareSnapshotIndex(
  input: SnapshotInput,
  inventory: SnapshotInventory,
  indexEnv: SnapshotIndexEnvironment,
  temporaryDirectory: string,
): Promise<{ missing: Set<string>; tracked: Set<string> }> {
  const metadataBytes = [
    ...inventory.headPaths.map((entry) => entry.path),
    ...inventory.paths.values(),
  ].reduce((total, entry) => total + 512 + 2 * entry.length, 0);
  await requestGitWorkerEffect<"worktree.snapshot-capacity">({
    type: "worktree.snapshot-capacity",
    input: {
      demands: [{ path: temporaryDirectory, bytes: 2 * metadataBytes }],
      purpose: "worktree safety snapshot index",
    },
  });
  await seedSnapshotIndex(input, inventory, indexEnv);
  // read-tree resets the private index to the already captured immutable tree.
  const tracked = new Set(inventory.headPaths.map((entry) => gitPathKey(entry.path)));
  const changed = new Set(
    splitNullBuffer(
      await requireGitBuffer(
        input.checkoutPath,
        [
          ...snapshotIndexArgs,
          "-c",
          "diff.autoRefreshIndex=true",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--name-only",
          "-z",
          "--",
        ],
        { env: indexEnv },
      ),
    ).map(gitPathKey),
  );
  const unique = new Map(
    [...inventory.paths].filter(([key]) => changed.has(key) || !tracked.has(key)),
  );
  for (const value of input.provisionedPaths) {
    unique.set(gitPathKey(Buffer.from(value)), Buffer.from(value));
  }
  const provisioned = new Set(
    input.provisionedPaths.map((value) => gitPathKey(Buffer.from(value))),
  );
  const missing = new Set<string>();
  let gitBytes = 0;
  let provisionedBytes = 0;
  for (const [key, value] of unique) {
    try {
      const stat = await fs.lstat(checkoutPathFromGitBytes(input.checkoutPath, value));
      if (provisioned.has(key)) {
        provisionedBytes += stat.size;
      } else {
        gitBytes += stat.size;
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      if (tracked.has(key)) {
        missing.add(key);
      }
    }
  }
  const common = normalizeGitPathForFilesystem(
    await requireGit(input.repoRoot, ["rev-parse", "--git-common-dir"]),
  );
  await requestGitWorkerEffect<"worktree.snapshot-capacity">({
    type: "worktree.snapshot-capacity",
    input: {
      demands: [
        { path: path.resolve(input.repoRoot, common), bytes: 2 * gitBytes + metadataBytes },
        { path: temporaryDirectory, bytes: 2 * metadataBytes },
      ],
      stateBytes: 2 * provisionedBytes,
      purpose: "worktree safety snapshot",
    },
  });
  return { missing, tracked };
}

function assertNoProvisionedTreePaths(tree: GitTreePath[], provisionedPaths: readonly string[]) {
  const provisioned = new Set(provisionedPaths.map((entry) => gitPathKey(Buffer.from(entry))));
  for (const entry of tree) {
    if (entry.mode === "160000") {
      throw new Error("nested git repositories cannot be snapshotted losslessly");
    }
    for (let end = entry.path.length; end >= 0; end = entry.path.lastIndexOf(47, end - 1)) {
      const prefix = entry.path.subarray(0, end);
      if (provisioned.has(gitPathKey(prefix))) {
        throw new Error(`provisioned path entered Git snapshot: ${prefix.toString("utf8")}`);
      }
      if (end === 0) {
        break;
      }
    }
  }
}

export async function snapshotWorktree(
  input: SnapshotInput,
): Promise<GitWorktreeOperations["worktree.snapshot"]["output"]> {
  await assertCurrent();
  const temporaryDirectory = await requestGitWorkerEffect<"git.temporary-directory">({
    type: "git.temporary-directory",
    input: {},
  });
  const snapshotRef = input.exactState
    ? `${exactSnapshotPrefix}${input.worktreeId}`
    : `refs/openclaw/snapshots/${input.worktreeId}`;
  const filemodeArgs = process.platform === "win32" ? [] : ["-c", "core.filemode=true"];
  const env: SnapshotIndexEnvironment = {
    GIT_INDEX_FILE: path.join(temporaryDirectory, "index"),
    GIT_AUTHOR_NAME: "OpenClaw",
    GIT_AUTHOR_EMAIL: "openclaw@localhost",
    GIT_COMMITTER_NAME: "OpenClaw",
    GIT_COMMITTER_EMAIL: "openclaw@localhost",
  };
  const inventory = await collectSnapshotInventory(input);
  await assertCurrent();
  const prepared = input.exactState
    ? undefined
    : await prepareSnapshotIndex(input, inventory, env, temporaryDirectory);
  const missing = prepared?.missing ?? new Set<string>();
  const tracked = prepared?.tracked ?? new Set<string>();
  const exact = input.exactState
    ? await captureExactState({
        checkoutPath: input.checkoutPath,
        ...input.exactState,
        paths: inventory.paths.values(),
        provisionedPaths: input.provisionedPaths,
        write: true,
        temporaryDirectory,
      })
    : undefined;
  const provisionedState = await requestGitWorkerEffect<"worktree.snapshot-provisioned">({
    type: "worktree.snapshot-provisioned",
    input: exact
      ? {
          expected: {
            algorithm: exact.metadata.head.length === 64 ? "sha256" : "sha1",
            files: exact.metadata.files
              .filter((entry) => entry.provisioned)
              .map((entry) => ({
                path: Buffer.from(entry.path, "hex").toString("utf8"),
                mode: entry.kind === "missing" ? null : entry.mode,
                size: entry.size,
                blob: entry.blob,
              })),
          },
        }
      : {},
  });
  const missingPaths: Buffer[] = [];
  const trackedPaths: Buffer[] = [];
  const addedPaths: Buffer[] = [];
  for (const [key, entry] of inventory.paths) {
    if (missing.has(key)) {
      missingPaths.push(entry);
    } else if (tracked.has(key)) {
      trackedPaths.push(entry);
    } else {
      addedPaths.push(entry);
    }
  }
  missingPaths.sort((left, right) => Buffer.compare(right, left));
  await assertCurrent();
  if (!exact) {
    await requireGit(
      input.checkoutPath,
      [...snapshotIndexArgs, "update-index", "--add", "--remove", "-z", "--stdin"],
      {
        env,
        input: Buffer.concat(
          [...missingPaths, ...trackedPaths, ...addedPaths].flatMap((entry) => [
            entry,
            Buffer.from([0]),
          ]),
        ),
      },
    );
    await assertCurrent();
  }
  if (exact) {
    await requireGit(input.checkoutPath, [...snapshotIndexArgs, "read-tree", "--empty"], { env });
    await requireGit(
      input.checkoutPath,
      [...snapshotIndexArgs, "update-index", "-z", "--index-info"],
      {
        env,
        input: Buffer.concat(exact.treeEntries),
      },
    );
  }
  const tree = await requireGit(input.checkoutPath, [...snapshotIndexArgs, "write-tree"], { env });
  assertNoProvisionedTreePaths(
    parseGitTreePaths(await requireGitBuffer(input.checkoutPath, ["ls-tree", "-r", "-z", tree])),
    input.provisionedPaths,
  );
  const assertHeadCurrent = async () => {
    const current = await requireGit(input.checkoutPath, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]);
    if (current !== inventory.head) {
      throw new Error("Worktree HEAD changed while preparing its snapshot; retry cleanup.");
    }
    await assertCurrent();
  };
  await assertHeadCurrent();
  const exactCommit = exact ? await writeExactStateCommit(input.checkoutPath, exact) : undefined;
  if (exact) {
    await verifyExactStateSnapshot({ ...input, expectedDigest: exact.digest });
  }
  const commit = await requireGit(
    input.checkoutPath,
    [
      ...filemodeArgs,
      "commit-tree",
      tree,
      "-p",
      inventory.head,
      ...(exactCommit ? ["-p", exactCommit] : []),
      "-m",
      `OpenClaw worktree snapshot: ${input.reason}`,
    ],
    { env },
  );
  await assertHeadCurrent();
  // Verify this checkout's HEAD inside publication, after shared-ref admission.
  // A commit made while the queue waits must preserve the checkout for retry.
  await requireGit(input.checkoutPath, ["update-ref", "--stdin", "-z"], {
    input: Buffer.from(
      `start\0verify HEAD\0${inventory.head}\0${input.exactState ? `verify refs/heads/${input.exactState.branch}\0${input.exactState.expected.branchHead}\0` : ""}update ${snapshotRef}\0${commit}\0\0prepare\0commit\0`,
    ),
  });
  return { snapshotRef, provisionedState, ...(exact ? { exactStateDigest: exact.digest } : {}) };
}

export async function verifyExactStateSnapshot(
  input: GitWorktreeOperations["worktree.snapshot-verify-exact"]["input"],
): Promise<boolean> {
  if (!input.exactState) {
    throw new Error("Exact-state verification requires captured authority");
  }
  await assertCurrent();
  const inventory = await collectSnapshotInventory(input);
  const captured = await captureExactState({
    checkoutPath: input.checkoutPath,
    ...input.exactState,
    paths: inventory.paths.values(),
    provisionedPaths: input.provisionedPaths,
    write: false,
  });
  await assertCurrent();
  if (captured.digest !== input.expectedDigest) {
    throw new Error(
      "Worktree contents or metadata changed after exact-state capture; checkout preserved",
    );
  }
  return true;
}

export async function inspectNestedRepository(checkoutPath: string): Promise<boolean> {
  const index = parseGitIndexPaths(
    await requireGitBuffer(checkoutPath, ["ls-files", "--stage", "-v", "-z"]),
  );
  if (index.some((entry) => entry.mode === "160000")) {
    return true;
  }
  return (
    (await containsGitMarker(
      checkoutPath,
      index.map((entry) => entry.path),
    )) ||
    (await inspectOtherPaths(checkoutPath, { unstattedIndexPaths: unstattedIndexPaths(index) }))
  );
}
