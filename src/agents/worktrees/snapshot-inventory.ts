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
  type GitTreePath,
} from "./git-path-inventory.js";
import type { GitWorktreeOperations } from "./git-worktree-operations.js";
import { commandError, requireGit, requireGitBuffer, runGit } from "./git.js";

type SnapshotInput = GitWorktreeOperations["worktree.snapshot"]["input"];
type SnapshotInventory = {
  head: string;
  headPaths: GitTreePath[];
  paths: Map<string, Buffer>;
};

const assertCurrent = () =>
  requestGitWorkerEffect<"worktree.assert-current">({ type: "worktree.assert-current", input: {} });

async function collectSnapshotInventory(input: SnapshotInput): Promise<SnapshotInventory> {
  const head = await requireGit(input.checkoutPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const headPaths = parseGitTreePaths(
    await requireGitBuffer(input.checkoutPath, ["ls-tree", "-r", "-z", head]),
  );
  const index = parseGitIndexPaths(
    await requireGitBuffer(input.checkoutPath, ["ls-files", "--stage", "-v", "-z"]),
  );
  const untracked = splitNullBuffer(
    await requireGitBuffer(input.checkoutPath, [
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
    ]),
  );
  const ignored = splitNullBuffer(
    await requireGitBuffer(input.checkoutPath, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
    ]),
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
  for (const entry of index) {
    sourcePaths.add(gitPathKey(entry.path));
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
  for (const entry of untracked) {
    add(entry);
  }
  const isStagedInput = createStagedInputPathMatcher(await fsRoot(input.checkoutPath));
  for (const entry of ignored) {
    const relativePath = entry.toString("utf8");
    if (stagedInputPathDirectory(relativePath) && (await isStagedInput(relativePath))) {
      add(entry);
    }
  }
  if (await containsGitMarker(input.checkoutPath, [...paths.values(), ...ignored])) {
    throw new Error("nested git repositories cannot be snapshotted losslessly");
  }
  return { head, headPaths, paths };
}

async function prepareSnapshotIndex(
  input: SnapshotInput,
  inventory: SnapshotInventory,
  indexEnv: NodeJS.ProcessEnv,
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
  await requireGit(input.checkoutPath, ["read-tree", inventory.head], { env: indexEnv });
  // read-tree owns this fresh index; its full path set is the already captured immutable tree.
  const tracked = new Set(inventory.headPaths.map((entry) => gitPathKey(entry.path)));
  const changed = new Set(
    splitNullBuffer(
      await requireGitBuffer(
        input.checkoutPath,
        [
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
  const snapshotRef = `refs/openclaw/snapshots/${input.worktreeId}`;
  const filemodeArgs = process.platform === "win32" ? [] : ["-c", "core.filemode=true"];
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: path.join(temporaryDirectory, "index"),
    GIT_AUTHOR_NAME: "OpenClaw",
    GIT_AUTHOR_EMAIL: "openclaw@localhost",
    GIT_COMMITTER_NAME: "OpenClaw",
    GIT_COMMITTER_EMAIL: "openclaw@localhost",
  };
  const inventory = await collectSnapshotInventory(input);
  await assertCurrent();
  const { missing, tracked } = await prepareSnapshotIndex(
    input,
    inventory,
    env,
    temporaryDirectory,
  );
  const provisionedState = await requestGitWorkerEffect<"worktree.snapshot-provisioned">({
    type: "worktree.snapshot-provisioned",
    input: {},
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
  await requireGit(
    input.checkoutPath,
    [...filemodeArgs, "update-index", "--add", "--remove", "-z", "--stdin"],
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
  const tree = await requireGit(input.checkoutPath, [...filemodeArgs, "write-tree"], { env });
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
  const commit = await requireGit(
    input.checkoutPath,
    [
      ...filemodeArgs,
      "commit-tree",
      tree,
      "-p",
      inventory.head,
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
      `start\0verify HEAD\0${inventory.head}\0update ${snapshotRef}\0${commit}\0\0prepare\0commit\0`,
    ),
  });
  return { snapshotRef, provisionedState };
}

export async function inspectNestedRepository(checkoutPath: string): Promise<boolean> {
  const index = parseGitIndexPaths(
    await requireGitBuffer(checkoutPath, ["ls-files", "--stage", "-v", "-z"]),
  );
  if (index.some((entry) => entry.mode === "160000")) {
    return true;
  }
  const untracked = splitNullBuffer(
    await requireGitBuffer(checkoutPath, ["ls-files", "-z", "--others", "--exclude-standard"]),
  );
  const ignored = splitNullBuffer(
    await requireGitBuffer(checkoutPath, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
    ]),
  );
  return await containsGitMarker(checkoutPath, [
    ...index.map((entry) => entry.path),
    ...untracked,
    ...ignored,
  ]);
}
