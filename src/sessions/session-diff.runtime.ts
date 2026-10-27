import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { readFileWindowFully } from "@openclaw/fs-safe/advanced";
import { root as openFsRoot, type Root } from "@openclaw/fs-safe/root";
import type {
  SessionDiffFile,
  SessionsDiffResult,
} from "../../packages/gateway-protocol/src/index.js";
import { runGit, runGitBuffered } from "../agents/worktrees/git.js";
import type { SessionDiffBaseline } from "../config/sessions/types.js";
import { normalizeGitPathForFilesystem } from "../infra/git-exec.js";
import type { GitCheckoutDiffInput, GitReadOperations } from "../infra/git-read-operations.js";
import { hasGitWorkerContext, requestGitWorkerEffect } from "../infra/git-worker-context.js";
import type { GitWorkerOperations } from "../infra/git-worker-contract.js";
import { isSqliteFilePath } from "../infra/sqlite-file-path.js";
import { parseDiffInventoryZ, parseNameStatusZ, splitPatchByFile } from "./session-diff-parser.js";
import {
  loadSessionDiffBranchMetadata,
  resolveSessionDiffBase,
  resolveSessionDiffEmptyTree,
} from "./session-diff-revisions.js";

const MAX_FILES = 500;
const MAX_UNTRACKED_FILES = 100;
const MAX_PATCH_BYTES_PER_FILE = 100_000;
const MAX_TOTAL_PATCH_BYTES = 1_500_000;
const MAX_BASELINE_GIT_OUTPUT_BYTES = 512_000;
const MAX_BASELINE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BASELINE_TOTAL_BYTES = 16 * 1024 * 1024;
// Past this the full-patch git call is skipped entirely: runGit buffers stdout
// in memory, so a pathological diff must degrade to stats-only entries.
const MAX_TOTAL_CHANGED_LINES = 100_000;
// Patch consumers require a/b paths. Pin formatting without changing Git's
// content conversions; read-scoped RPCs must not execute diff/textconv drivers.
const PATCH_DIFF_ARGS = [
  "--patch",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

async function gitOut(
  cwd: string,
  args: string[],
  okCodes: readonly number[] = [0],
): Promise<string | null> {
  try {
    // quotePath=false keeps non-ASCII paths raw instead of octal-escaped, so
    // -z output tokens match the byte-for-byte paths git reports elsewhere.
    const result = await runGit(cwd, ["-c", "core.quotePath=false", ...args]);
    return okCodes.includes(result.code ?? -1) ? result.stdout : null;
  } catch {
    return null;
  }
}

async function loadCheckoutRevision(
  cwd: string,
): Promise<{ root: string; head?: string; branch?: string; objectFormat?: string } | undefined> {
  try {
    // Keep format/root options before --verify: old Git echoes unknown options here,
    // and exit 1 still preserves an unborn checkout's root. Only remove the first
    // format line and final successful OID so embedded root newlines remain intact.
    const result = await runGit(cwd, [
      "rev-parse",
      "--show-object-format",
      "--show-toplevel",
      "--verify",
      "--quiet",
      "HEAD",
    ]);
    if (result.termination !== "exit" || (result.code !== 0 && result.code !== 1)) {
      return undefined;
    }
    const lines = result.stdout.replace(/\n$/, "").split("\n");
    const objectFormat = lines.shift();
    const head = result.code === 0 ? lines.pop() : undefined;
    const root = lines.join("\n");
    if (!root) {
      return undefined;
    }
    const branchOut = head
      ? (await gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim()
      : undefined;
    return {
      root,
      head,
      branch: branchOut && branchOut !== "HEAD" ? branchOut : undefined,
      objectFormat,
    };
  } catch {
    return undefined;
  }
}

function readPatchHeader(chunk: string): { additions?: number; binary: boolean } {
  // A null-to-file addition has one hunk spanning the converted postimage.
  // Stop at the first LF-delimited header so content (including CR) cannot
  // masquerade as binary metadata or a later hunk.
  const header = /(?:^|\n)(@@ [^\n]*|Binary files [^\n]* differ|GIT binary patch)\n/.exec(
    chunk,
  )?.[1];
  const added = /^@@ -0,0 \+1(?:,(\d+))? @@(?: |$)/.exec(header ?? "");
  return {
    ...(added ? { additions: Number(added[1] ?? 1) } : {}),
    binary: header !== undefined && !header.startsWith("@@ "),
  };
}

/**
 * A patch-producing `git diff` reads working-tree file contents, so a
 * checkout-planted hardlink to an out-of-tree secret would otherwise leak
 * through this read-scoped RPC (same threat the fs-safe workspace readers
 * reject). Content is only emitted for a real, single-linked regular file
 * whose realpath stays inside the checkout. Deleted files are exempt: git
 * reads their content from the object DB, never the filesystem.
 */
async function isPatchableWorkingTreePath(realRoot: string, relPath: string): Promise<boolean> {
  const abs = nodePath.resolve(realRoot, relPath);
  try {
    const info = await fs.lstat(abs);
    // Symlinks never leak file contents (git diff shows the link target text,
    // not the pointee), but a hardlink is a second name for another inode.
    if (!info.isFile() || info.nlink !== 1) {
      return false;
    }
    const resolved = await fs.realpath(abs);
    return resolved === realRoot || resolved.startsWith(realRoot + nodePath.sep);
  } catch {
    return false;
  }
}

type PatchBudget = { remaining: number };

function takePatch(
  chunk: string | undefined,
  budget: PatchBudget,
): { patch?: string; truncated?: boolean } {
  if (!chunk) {
    return { truncated: true };
  }
  const bytes = Buffer.byteLength(chunk, "utf8");
  if (bytes > MAX_PATCH_BYTES_PER_FILE || bytes > budget.remaining) {
    return { truncated: true };
  }
  budget.remaining -= bytes;
  return { patch: chunk };
}

async function collectUntrackedFiles(
  root: string,
  realRoot: string,
  budget: PatchBudget,
  summaryOnly: boolean,
): Promise<{ files: SessionDiffFile[]; truncated: boolean }> {
  const listing = await gitOut(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (listing === null) {
    throw new Error("Unable to read untracked Git changes");
  }
  const paths = listing.split("\0", MAX_UNTRACKED_FILES + 1).filter(Boolean);
  const truncated = paths.length > MAX_UNTRACKED_FILES;
  const files: SessionDiffFile[] = [];
  const safePaths: string[] = [];
  for (const filePath of paths.slice(0, MAX_UNTRACKED_FILES)) {
    const file: SessionDiffFile = {
      path: filePath,
      status: "added",
      additions: 0,
      deletions: 0,
      untracked: true,
    };
    files.push(file);
    if (await isPatchableWorkingTreePath(realRoot, filePath)) {
      safePaths.push(filePath);
    } else {
      file.truncated = true;
    }
  }
  if (safePaths.length === 0) {
    return { files, truncated };
  }
  const directory = hasGitWorkerContext()
    ? await requestGitWorkerEffect({ type: "git.temporary-directory", input: {} })
    : await fs.mkdtemp(nodePath.join(os.tmpdir(), "openclaw-diff-"));
  try {
    const objectsPath = await gitOut(root, ["rev-parse", "--git-path", "objects"]);
    if (objectsPath === null) {
      throw new Error("Unable to prepare untracked Git changes");
    }
    const resolveGitPath = (value: string) =>
      nodePath.resolve(root, normalizeGitPathForFilesystem(value.replace(/\r?\n$/, "")));
    const index = nodePath.join(directory, "index");
    // Like --no-index, start without tracked entries or index-backed attributes.
    // Intent-to-add writes only to this private index/object store, never the checkout.
    const objects = nodePath.join(directory, "objects");
    await fs.mkdir(nodePath.join(objects, "info"), { recursive: true });
    // Keep inherited alternate stores while adding the checkout's primary store.
    const alternate = [...Buffer.from(resolveGitPath(objectsPath))]
      .map((byte) => `\\${byte.toString(8).padStart(3, "0")}`)
      .join("");
    await fs.writeFile(nodePath.join(objects, "info", "alternates"), `"${alternate}"\n`);
    const env = {
      GIT_INDEX_FILE: index,
      GIT_OBJECT_DIRECTORY: objects,
    };
    const args = [
      "--literal-pathspecs",
      "-c",
      "core.quotePath=false",
      "-c",
      "core.filemode=true",
      "-c",
      "core.splitIndex=false",
    ];
    const added = await runGit(
      root,
      [
        ...args,
        "add",
        "--intent-to-add",
        "--sparse",
        "--ignore-errors",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
      ],
      { env, input: safePaths.join("\0") + "\0" },
    );
    if (added.termination !== "exit" || (added.code !== 0 && added.code !== 1)) {
      throw new Error("Unable to prepare untracked Git changes");
    }
    const read = (selected: string[]) =>
      runGit(
        root,
        [
          ...args,
          "diff",
          ...(summaryOnly
            ? ["--numstat", "-z", "--no-color", "--no-ext-diff", "--no-textconv"]
            : PATCH_DIFF_ARGS),
          "--ita-invisible-in-index",
          "--",
          ...selected,
        ],
        { env, ...(!summaryOnly ? { maxPatchBytes: MAX_PATCH_BYTES_PER_FILE } : {}) },
      );
    const result = await read(safePaths);
    const output: string[] = [];
    const failed = new Set<string>();
    if (result.termination === "exit" && result.code === 0) {
      output.push(result.stdout);
    } else {
      // A required clean filter can fail one file. Preserve the RPC's partial-result
      // contract with isolated retries only after a failed batch, never on healthy polls.
      for (const filePath of safePaths) {
        const single = await read([filePath]);
        if (single.termination === "exit" && single.code === 0) {
          output.push(single.stdout);
        } else {
          failed.add(filePath);
        }
      }
    }
    const text = output.join("");
    const stats = summaryOnly ? parseDiffInventoryZ(text).numstat : undefined;
    const patches = summaryOnly ? undefined : splitPatchByFile(text);
    for (const file of files) {
      if (failed.has(file.path)) {
        file.truncated = true;
      }
      if (file.truncated) {
        continue;
      }
      if (stats) {
        const stat = stats.get(file.path);
        if (stat) {
          file.additions = stat.additions;
          file.deletions = stat.deletions;
          if (stat.binary) {
            file.binary = true;
          }
        }
      } else {
        const patch = patches?.get(file.path);
        const header = readPatchHeader(patch ?? "");
        file.additions = header.additions ?? 0;
        if (header.binary) {
          file.binary = true;
        } else {
          Object.assign(file, takePatch(patch, budget));
        }
      }
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  return { files, truncated };
}

async function collectTrackedFiles(
  root: string,
  realRoot: string,
  revisions: readonly [base: string] | readonly [base: string, target: string],
  budget: PatchBudget,
  summaryOnly: boolean,
): Promise<{ files: SessionDiffFile[]; truncated: boolean }> {
  const diffArgs = (options: string[]) => ["diff", "-M", ...options, ...revisions, "--"];
  const inventoryText = await gitOut(
    root,
    diffArgs(["--raw", "--numstat", "--no-color", "--no-ext-diff", "--no-textconv", "-z"]),
  );
  if (inventoryText === null) {
    throw new Error("Unable to read tracked Git changes");
  }
  const { entries, numstat } = parseDiffInventoryZ(inventoryText);
  if (entries.length === 0) {
    return { files: [], truncated: false };
  }
  const totalChangedLines = [...numstat.values()].reduce(
    (sum, entry) => sum + entry.additions + entry.deletions,
    0,
  );
  const patchText =
    summaryOnly || totalChangedLines > MAX_TOTAL_CHANGED_LINES
      ? null
      : await gitOut(root, diffArgs(PATCH_DIFF_ARGS));
  const chunks = patchText === null ? new Map<string, string>() : splitPatchByFile(patchText);
  const truncated = entries.length > MAX_FILES;
  const files: SessionDiffFile[] = [];
  for (const entry of entries.slice(0, MAX_FILES)) {
    const stat = numstat.get(entry.path);
    const chunk = chunks.get(entry.path);
    const binary = stat?.binary === true || (chunk !== undefined && readPatchHeader(chunk).binary);
    const file: SessionDiffFile = {
      path: entry.path,
      status: entry.status,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
    };
    if (entry.oldPath) {
      file.oldPath = entry.oldPath;
    }
    if (binary) {
      file.binary = true;
    }
    if (binary || summaryOnly) {
      files.push(file);
      continue;
    }
    // Like the deleted-file exemption, two-revision commit diffs read every
    // path from the object DB. Only working-tree content needs the hardlink guard.
    const safe =
      revisions.length === 2 ||
      entry.status === "deleted" ||
      (await isPatchableWorkingTreePath(realRoot, entry.path));
    if (!safe) {
      file.truncated = true;
      files.push(file);
      continue;
    }
    Object.assign(file, takePatch(chunk, budget));
    files.push(file);
  }
  return { files, truncated };
}

type CheckoutDiffResult = GitReadOperations["checkout.diff"]["output"];

export async function collectCheckoutDiff(
  params: GitWorkerOperations["checkout.diff"]["input"],
): Promise<CheckoutDiffResult> {
  const empty = (
    unavailableReason?: NonNullable<SessionsDiffResult["unavailableReason"]>,
  ): CheckoutDiffResult => ({
    files: [],
    additions: 0,
    deletions: 0,
    ...(unavailableReason ? { unavailableReason } : {}),
  });
  const checkout = await loadCheckoutRevision(params.cwd);
  if (!checkout) {
    return empty("not_git");
  }
  const { root, head, branch, objectFormat } = checkout;
  // Canonical root for the hardlink/escape guard: show-toplevel can contain
  // symlinked path segments, and containment is compared against realpaths.
  const realRoot = await fs.realpath(root).catch(() => root);
  const branchBase = params.baseCommit
    ? { base: params.baseCommit, baseRef: params.baseCommit }
    : head
      ? await resolveSessionDiffBase({ branch, gitOut, head, root })
      : await resolveSessionDiffEmptyTree(root, objectFormat);
  const metadata =
    head && branchBase && !params.summaryOnly
      ? await loadSessionDiffBranchMetadata({ base: branchBase.base, gitOut, head, root })
      : {};
  const repositoryFields = {
    root,
    ...(branch ? { branch } : {}),
    ...(branchBase?.baseRef ? { baseRef: branchBase.baseRef } : {}),
    ...metadata,
  };
  const unknownCommit = (): CheckoutDiffResult => ({
    ...repositoryFields,
    files: [],
    additions: 0,
    deletions: 0,
    unavailableReason: "unknown_commit",
  });
  const scope = params.scope ?? "all";
  // Fresh status already inventoried both tracked and untracked changes. Reuse
  // that read snapshot only for the same checkout/HEAD and uncommitted scope.
  if (
    scope === "uncommitted" &&
    params.cleanWorktree?.root === realRoot &&
    params.cleanWorktree.head === head
  ) {
    return { ...repositoryFields, files: [], additions: 0, deletions: 0 };
  }
  let revisions: readonly [string] | readonly [string, string] | undefined;
  if (scope === "commit") {
    if (!head || !branchBase || branchBase.base === "HEAD" || branchBase.base === head) {
      return unknownCommit();
    }
    const commit = (
      await gitOut(root, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${params.commit}^{commit}`,
      ])
    )?.trim();
    if (!commit) {
      return unknownCommit();
    }
    // Commit scope is fenced to the advertised merge-base..HEAD history so an
    // operator.read client cannot read arbitrary commits from the object database.
    const isCommitInHeadHistory =
      (await gitOut(root, ["merge-base", "--is-ancestor", commit, head], [0])) !== null;
    const isCommitInBaseHistory =
      (await gitOut(root, ["merge-base", "--is-ancestor", commit, branchBase.base], [0])) !== null;
    if (!isCommitInHeadHistory || isCommitInBaseHistory) {
      return unknownCommit();
    }
    const parent = (await gitOut(root, ["rev-parse", "--verify", "--quiet", `${commit}^`]))?.trim();
    const commitBase = parent
      ? { base: parent }
      : await resolveSessionDiffEmptyTree(root, objectFormat);
    revisions = commitBase ? [commitBase.base, commit] : undefined;
  } else if (scope === "uncommitted") {
    revisions = head ? [head] : branchBase ? [branchBase.base] : undefined;
  } else {
    revisions = branchBase ? [branchBase.base] : undefined;
  }
  const budget: PatchBudget = { remaining: MAX_TOTAL_PATCH_BYTES };
  const tracked = revisions
    ? await collectTrackedFiles(root, realRoot, revisions, budget, params.summaryOnly === true)
    : { files: [], truncated: false };
  const untracked =
    scope === "commit"
      ? { files: [], truncated: false }
      : await collectUntrackedFiles(root, realRoot, budget, params.summaryOnly === true);
  const files = [...tracked.files, ...untracked.files].toSorted((a, b) =>
    a.path.localeCompare(b.path),
  );
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const truncated =
    tracked.truncated || untracked.truncated || files.some((file) => file.truncated === true);
  const diff = {
    ...repositoryFields,
    files,
    additions,
    deletions,
    ...(truncated ? { truncated: true } : {}),
  };
  return params.sessionId
    ? await applySessionDiffBaseline({
        baseline: params.baseline,
        checkout,
        // Stored fingerprints use the default base, not an explicit managed review base.
        defaultBase: params.baseCommit ? undefined : branchBase,
        diff,
        scope,
        sessionId: params.sessionId,
      })
    : diff;
}

type BaselineCandidate = Pick<SessionDiffFile, "oldPath" | "path" | "status" | "untracked">;

type BaselineHashBudget = { remaining: number };

function hashBaselineDescriptor(
  candidate: BaselineCandidate,
  content: string,
  bytes?: Buffer,
): string {
  return crypto
    .createHash("sha256")
    .update(
      [
        candidate.path,
        candidate.oldPath ?? "",
        candidate.status,
        candidate.untracked === true ? "untracked" : "tracked",
        content,
      ].join("\0"),
    )
    .update(bytes ?? "")
    .digest("hex");
}

async function fingerprintBaselineCandidate(params: {
  budget: BaselineHashBudget;
  candidate: BaselineCandidate;
  directory: Root | undefined;
  root: string;
}): Promise<string | undefined> {
  const { candidate } = params;
  if (candidate.status === "deleted") {
    return hashBaselineDescriptor(candidate, "deleted");
  }
  const absolutePath = nodePath.resolve(params.root, candidate.path);
  const relativePath = nodePath.relative(params.root, absolutePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${nodePath.sep}`) ||
    nodePath.isAbsolute(relativePath)
  ) {
    return undefined;
  }
  const initial = await fs.lstat(absolutePath).catch(() => undefined);
  if (!initial) {
    return undefined;
  }
  if (initial.isSymbolicLink()) {
    const target = await fs.readlink(absolutePath).catch(() => undefined);
    return target === undefined
      ? undefined
      : hashBaselineDescriptor(candidate, `symlink:${target}`);
  }
  // Even a raw close in a Worker releases the Gateway's SQLite POSIX locks.
  // Skip before opening: fs-safe's hardlink rejection also closes its descriptor.
  if (initial.nlink !== 1 || isSqliteFilePath(absolutePath)) {
    return undefined;
  }
  const opened = await params.directory
    ?.open(`.${nodePath.sep}${relativePath}`)
    .catch(() => undefined);
  if (!opened) {
    return undefined;
  }
  await using file = opened;
  const { mode, size } = file.stat;
  if (size > MAX_BASELINE_FILE_BYTES || size > params.budget.remaining) {
    return undefined;
  }
  params.budget.remaining -= size;
  const buffer = Buffer.allocUnsafe(size);
  if ((await readFileWindowFully(file.handle, buffer, 0)) !== size) {
    return undefined;
  }
  return hashBaselineDescriptor(candidate, `${mode}\0${size}`, buffer);
}

async function gitOutForBaseline(cwd: string, args: string[]): Promise<string | null> {
  const result = await runGitBuffered(cwd, ["-c", "core.quotePath=false", ...args], {
    timeoutMs: 30_000,
    maxOutputBytes: {
      stdout: MAX_BASELINE_GIT_OUTPUT_BYTES,
      stderr: 32 * 1024,
    },
  });
  if (result.termination !== "exit" || result.code !== 0) {
    return null;
  }
  return result.stdout.toString("utf8");
}

async function collectBaselineCandidates(
  checkout: NonNullable<Awaited<ReturnType<typeof loadCheckoutRevision>>>,
  untrackedPaths?: string[],
  defaultBase?: { base: string } | null,
): Promise<{ candidates: BaselineCandidate[]; root: string; truncated: boolean }> {
  const { root, head, branch, objectFormat } = checkout;
  const baseInfo =
    defaultBase !== undefined
      ? defaultBase
      : head
        ? await resolveSessionDiffBase({ branch, gitOut, head, root })
        : await resolveSessionDiffEmptyTree(root, objectFormat);
  const [trackedText, untracked] = await Promise.all([
    baseInfo
      ? gitOutForBaseline(root, ["diff", "-M", baseInfo.base, "--name-status", "-z"])
      : Promise.resolve(""),
    untrackedPaths ??
      gitOutForBaseline(root, ["ls-files", "--others", "--exclude-standard", "-z"]).then((text) =>
        text === null ? null : text.split("\0").filter(Boolean),
      ),
  ]);
  if (trackedText === null || untracked === null) {
    return { root, candidates: [], truncated: true };
  }
  const tracked = parseNameStatusZ(trackedText);
  const candidates = [
    ...tracked.slice(0, MAX_FILES),
    ...untracked.slice(0, MAX_UNTRACKED_FILES).map((path) => ({
      path,
      status: "added" as const,
      untracked: true,
    })),
  ].toSorted((left, right) => left.path.localeCompare(right.path));
  return {
    root,
    candidates,
    truncated: tracked.length > MAX_FILES || untracked.length > MAX_UNTRACKED_FILES,
  };
}

export async function collectCheckoutDiffBaseline(params: {
  cwd: string;
}): Promise<GitReadOperations["checkout.baseline"]["output"]> {
  const checkout = await loadCheckoutRevision(params.cwd);
  if (!checkout) {
    return undefined;
  }
  const collected = await collectBaselineCandidates(checkout);
  const fingerprinted = await fingerprintBaselineCandidates(collected);
  return {
    version: 1,
    root: collected.root,
    files: fingerprinted.files,
    ...(collected.truncated || fingerprinted.truncated ? { truncated: true } : {}),
  };
}

async function fingerprintBaselineCandidates(params: {
  candidates: BaselineCandidate[];
  root: string;
}): Promise<{ files: SessionDiffBaseline["files"]; truncated: boolean }> {
  const directory = await openFsRoot(params.root, {
    hardlinks: "reject",
    symlinks: "follow-parents-within-root",
  }).catch(() => undefined);
  const budget: BaselineHashBudget = { remaining: MAX_BASELINE_TOTAL_BYTES };
  const files: SessionDiffBaseline["files"] = [];
  for (const candidate of params.candidates) {
    const fingerprint = await fingerprintBaselineCandidate({
      budget,
      candidate,
      directory,
      root: params.root,
    });
    if (fingerprint) {
      files.push({ path: candidate.path, fingerprint });
    }
  }
  return { files, truncated: files.length !== params.candidates.length };
}

async function applySessionDiffBaseline(params: {
  baseline: SessionDiffBaseline | undefined;
  checkout: NonNullable<Awaited<ReturnType<typeof loadCheckoutRevision>>>;
  defaultBase: { base: string } | null | undefined;
  diff: CheckoutDiffResult;
  scope: NonNullable<GitCheckoutDiffInput["scope"]>;
  sessionId: string;
}): Promise<CheckoutDiffResult> {
  const { baseline, diff } = params;
  if (
    baseline?.version !== 1 ||
    baseline.sessionId !== params.sessionId ||
    !diff.root ||
    baseline.root !== diff.root
  ) {
    return diff;
  }
  const fingerprints = new Map(baseline.files.map((file) => [file.path, file.fingerprint]));
  // No returned path can be hidden by this baseline; avoid another checkout scan.
  if (!diff.files.some((file) => fingerprints.has(file.path))) {
    return diff;
  }
  const candidates =
    params.scope === "uncommitted" &&
    diff.files.some((file) => !file.untracked && fingerprints.has(file.path))
      ? (
          await collectBaselineCandidates(
            params.checkout,
            diff.files.filter((file) => file.untracked).map((file) => file.path),
            params.defaultBase,
          )
        ).candidates
      : diff.files;
  const visiblePaths = new Set(diff.files.map((file) => file.path));
  // New paths cannot match the baseline; hashing them can exhaust the budget
  // before an unchanged pre-session file is compared.
  const current = await fingerprintBaselineCandidates({
    candidates: candidates.filter(
      (file) => fingerprints.has(file.path) && visiblePaths.has(file.path),
    ),
    root: diff.root,
  });
  const currentFingerprints = new Map(current.files.map((file) => [file.path, file.fingerprint]));
  const files = diff.files.filter((file) => {
    const baselineFingerprint = fingerprints.get(file.path);
    return !baselineFingerprint || currentFingerprints.get(file.path) !== baselineFingerprint;
  });
  if (files.length === diff.files.length) {
    return diff;
  }
  return {
    ...diff,
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}
