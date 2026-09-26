import { createHash } from "node:crypto";
import fsSync, { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isMissingPathError } from "../../infra/errors.js";
import { normalizeGitPathForFilesystem } from "../../infra/git-exec.js";
import { requestGitWorkerEffect } from "../../infra/git-worker-context.js";
import { checkoutPathFromGitBytes, rawPathExists, rawPathStat } from "./git-path-inventory.js";
import { requireGit, requireGitBuffer, runGit } from "./git.js";
import type { ExactStateRetirement } from "./snapshot-exact-state-contract.js";
import { exactIndexObjects } from "./snapshot-index-objects.js";

const oid = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
const entrySchema = z
  .object({
    path: z.string().regex(/^(?:[a-f0-9]{2})+$/u),
    kind: z.enum(["file", "symlink", "directory", "missing"]),
    mode: z.number().int().nonnegative(),
    mtimeMs: z.number().finite(),
    blob: oid.optional(),
    provisioned: z.boolean(),
    size: z.number().int().nonnegative(),
  })
  .strict();
const metadataSchema = z
  .object({
    version: z.literal(1),
    sourceIdentity: z
      .object({ device: z.string().regex(/^\d+$/u), inode: z.string().regex(/^\d+$/u) })
      .strict(),
    retirementName: z.string().regex(/^\.openclaw-retiring-[a-f0-9-]{36}$/u),
    head: oid,
    branch: z.string(),
    branchHead: oid,
    indexSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    index: z.object({ blob: oid, mode: z.number().int(), mtimeMs: z.number().finite() }).strict(),
    sharedIndex: z
      .object({
        name: z.string().regex(/^sharedindex\.[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
        blob: oid,
      })
      .strict()
      .optional(),
    files: z.array(entrySchema),
  })
  .strict();
export type ExactStateSnapshot = z.infer<typeof metadataSchema>;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const exactSnapshotPrefix = "refs/openclaw/snapshots/exact-v1/";
const identity = {
  GIT_AUTHOR_NAME: "OpenClaw",
  GIT_AUTHOR_EMAIL: "openclaw@localhost",
  GIT_COMMITTER_NAME: "OpenClaw",
  GIT_COMMITTER_EMAIL: "openclaw@localhost",
};
const assertSnapshotCurrent = () =>
  requestGitWorkerEffect<"worktree.assert-current">({ type: "worktree.assert-current", input: {} });

/** Keep raw Git path bytes, but never allow archive paths to traverse or alias Git metadata. */
function checkedPath(hex: string): Buffer {
  const bytes = Buffer.from(hex, "hex");
  if (
    bytes.includes(0) ||
    bytes[0] === 47 ||
    (bytes.includes(92) && process.platform === "win32") ||
    bytes
      .toString("latin1")
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
    (process.platform === "win32" && bytes.includes(58))
  ) {
    throw new Error("Invalid path in exact-state snapshot");
  }
  return bytes;
}
async function checkParents(root: string, relative: Buffer, allowMissing = false) {
  const parents: (string | Buffer)[] = [root];
  for (let slash = relative.indexOf(47); slash !== -1; slash = relative.indexOf(47, slash + 1)) {
    parents.push(checkoutPathFromGitBytes(root, relative.subarray(0, slash)));
  }
  const observed = await Promise.all(
    parents.map(async (parent) => {
      const stat = await fs.lstat(parent, { bigint: true }).catch((error: unknown) => {
        if (allowMissing && parent !== root && isMissingPathError(error)) {
          return undefined;
        }
        throw error;
      });
      if (stat && !stat.isDirectory()) {
        throw new Error("Exact-state path has a non-directory parent; checkout preserved");
      }
      return { parent, stat };
    }),
  );
  // Raw Git paths need Buffer names. Recheck every captured parent immediately
  // before the synchronous mutation, without yielding to another workspace writer.
  return () => {
    for (const { parent, stat } of observed) {
      const current = fsSync.lstatSync(parent, { bigint: true, throwIfNoEntry: !allowMissing });
      if (
        stat
          ? !current?.isDirectory() || current.dev !== stat.dev || current.ino !== stat.ino
          : current !== undefined
      ) {
        throw new Error("Exact-state parent directory changed; source preserved");
      }
    }
  };
}
async function indexPath(cwd: string) {
  return path.resolve(
    cwd,
    normalizeGitPathForFilesystem(await requireGit(cwd, ["rev-parse", "--git-path", "index"])),
  );
}
function blobOid(bytes: Buffer, algorithm: string) {
  return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
function quotePath(bytes: Buffer) {
  return '"' + [...bytes].map((b) => `\\${b.toString(8).padStart(3, "0")}`).join("") + '"';
}

/** Capture before publication, then recapture at deletion admission. Ignored bytes stay in SQLite. */
export async function captureExactState(input: {
  checkoutPath: string;
  branch: string;
  expected: ExactStateRetirement;
  retirementName: string;
  paths: Iterable<Buffer>;
  provisionedPaths: readonly string[];
  write: boolean;
  temporaryDirectory?: string;
}): Promise<{
  metadata: ExactStateSnapshot;
  digest: string;
  treeEntries: Buffer[];
  metadataEntries: string[];
}> {
  const params = { ...input, paths: [...input.paths] };
  const cwd = params.checkoutPath;
  const sourceStat = await fs.lstat(cwd, { bigint: true });
  if (!sourceStat.isDirectory()) {
    throw new Error("Exact-state source is no longer a directory; source preserved");
  }
  const sparse = await runGit(cwd, ["config", "--bool", "core.sparseCheckout"]);
  if (sparse.code !== 1 && (sparse.code !== 0 || sparse.stdout.trim() !== "false")) {
    throw new Error(
      "Exact-state retirement requires a full, non-sparse checkout; source preserved",
    );
  }
  const head = await requireGit(cwd, ["rev-parse", "HEAD^{commit}"]);
  const branchHead = await requireGit(cwd, ["rev-parse", `refs/heads/${params.branch}^{commit}`]);
  const sourceIndex = await indexPath(cwd);
  const indexStat = await fs.lstat(sourceIndex);
  if (!indexStat.isFile()) {
    throw new Error("Exact-state retirement requires a regular Git index");
  }
  const indexBytes = await fs.readFile(sourceIndex);
  const indexSha256 = sha256(indexBytes);
  if (
    head !== params.expected.head ||
    branchHead !== params.expected.branchHead ||
    indexSha256 !== params.expected.indexSha256
  ) {
    throw new Error("Worktree HEAD, branch or index changed; checkout preserved");
  }
  const algorithm = head.length === 64 ? "sha256" : "sha1";
  if (params.write) {
    let bytes = indexBytes.length;
    for (const relative of params.paths) {
      const stat = await rawPathStat(checkoutPathFromGitBytes(cwd, relative));
      bytes += (stat?.size ?? 0) + 1024 + relative.length * 4;
    }
    let provisionedBytes = 0;
    for (const relative of params.provisionedPaths) {
      const stat = await rawPathStat(path.join(cwd, relative));
      provisionedBytes += stat?.size ?? 0;
    }
    const common = path.resolve(
      cwd,
      normalizeGitPathForFilesystem(await requireGit(cwd, ["rev-parse", "--git-common-dir"])),
    );
    await requestGitWorkerEffect<"worktree.snapshot-capacity">({
      type: "worktree.snapshot-capacity",
      input: {
        demands: [
          { path: common, bytes: 2 * bytes },
          ...(params.temporaryDirectory
            ? [{ path: params.temporaryDirectory, bytes: 2 * bytes }]
            : []),
        ],
        stateBytes: 2 * provisionedBytes,
        purpose: "worktree safety snapshot",
      },
    });
  }
  const metadataEntries: string[] = [];
  const putBlob = async (name: string, bytes: Buffer) => {
    const blob = blobOid(bytes, algorithm);
    if (params.write) {
      const stored = await requireGit(cwd, ["hash-object", "--no-filters", "-w", "--stdin"], {
        input: bytes,
      });
      if (stored !== blob) {
        throw new Error("Git exact-state object verification failed");
      }
    }
    metadataEntries.push(`100644 blob ${blob}\t${name}\0`);
    return blob;
  };
  const index = {
    blob: await putBlob("index", indexBytes),
    mode: indexStat.mode & 0o7777,
    mtimeMs: indexStat.mtimeMs,
  };
  const indexObjects = exactIndexObjects(indexBytes, head.length === 64 ? 32 : 20);
  const sharedPath = await requireGit(cwd, ["rev-parse", "--shared-index-path"]);
  let sharedIndex: ExactStateSnapshot["sharedIndex"];
  if (sharedPath) {
    const source = path.resolve(cwd, normalizeGitPathForFilesystem(sharedPath));
    const name = path.basename(source);
    if (!/^sharedindex\.[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(name)) {
      throw new Error("Invalid split-index dependency");
    }
    const bytes = await fs.readFile(source);
    sharedIndex = { name, blob: await putBlob(name, bytes) };
    for (const [object, kind] of exactIndexObjects(bytes, head.length === 64 ? 32 : 20)) {
      indexObjects.set(object, kind);
    }
  }
  // A raw index is not Git reachability. Pin cache entries and extension
  // dependencies, including cache-tree and resolve-undo objects.
  for (const [object, kind] of indexObjects) {
    metadataEntries.push(
      `${kind === "tree" ? "040000" : "100644"} ${kind} ${object}\tindex-object-${object}\0`,
    );
  }
  const provisioned = new Set(params.provisionedPaths.map((p) => Buffer.from(p).toString("hex")));
  const paths = new Map(
    [...params.paths, ...params.provisionedPaths.map((p) => Buffer.from(p))].map((p) => [
      p.toString("hex"),
      p,
    ]),
  );
  // Directory permissions and mtimes are independent of Git's executable bit.
  const filePaths = Array.from(paths.values());
  for (const entry of filePaths) {
    for (let slash = entry.indexOf(47); slash !== -1; slash = entry.indexOf(47, slash + 1)) {
      const directory = entry.subarray(0, slash);
      paths.set(directory.toString("hex"), directory);
    }
  }
  const files: ExactStateSnapshot["files"] = [];
  const treeEntries: Buffer[] = [];
  const regular: { path: Buffer; blob: string }[] = [];
  for (const [hex, relative] of [...paths].toSorted(([a], [b]) => a.localeCompare(b))) {
    checkedPath(hex);
    let stat;
    try {
      await checkParents(cwd, relative);
      stat = await fs.lstat(checkoutPathFromGitBytes(cwd, relative));
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      files.push({
        path: hex,
        kind: "missing",
        mode: 0,
        size: 0,
        mtimeMs: 0,
        provisioned: provisioned.has(hex),
      });
      continue;
    }
    const kind = stat.isFile()
      ? "file"
      : stat.isSymbolicLink()
        ? "symlink"
        : stat.isDirectory()
          ? "directory"
          : undefined;
    if (!kind) {
      throw new Error("Exact-state snapshot contains an unsupported file type; checkout preserved");
    }
    const entry: ExactStateSnapshot["files"][number] = {
      path: hex,
      kind,
      mode: stat.mode & 0o7777,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      provisioned: provisioned.has(hex),
    };
    if (kind !== "directory") {
      const filename = checkoutPathFromGitBytes(cwd, relative);
      let bytes: Buffer;
      if (kind === "symlink") {
        bytes = await fs.readlink(filename, { encoding: "buffer" });
      } else {
        const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          bytes = await handle.readFile();
        } finally {
          await handle.close();
        }
      }
      entry.blob = blobOid(bytes, algorithm);
      if (!entry.provisioned) {
        if (kind === "symlink") {
          await putBlob(`symlink-${files.length}`, bytes);
        } else {
          regular.push({ path: relative, blob: entry.blob });
        }
        const mode = kind === "symlink" ? "120000" : entry.mode & 0o111 ? "100755" : "100644";
        treeEntries.push(
          Buffer.concat([Buffer.from(`${mode} ${entry.blob}\t`), relative, Buffer.from([0])]),
        );
      }
    }
    files.push(entry);
  }
  if (params.write) {
    for (let offset = 0; offset < regular.length; offset += 128) {
      await assertSnapshotCurrent();
      const batch = regular.slice(offset, offset + 128);
      const stored = (
        await requireGit(cwd, ["hash-object", "--no-filters", "-w", "--stdin-paths"], {
          input: Buffer.from(batch.map((e) => quotePath(e.path) + "\n").join("")),
        })
      ).split("\n");
      if (stored.some((value, i) => value !== batch[i]?.blob) || stored.length !== batch.length) {
        throw new Error("Worktree files changed during exact-state capture; checkout preserved");
      }
    }
  }
  const metadata: ExactStateSnapshot = {
    version: 1,
    sourceIdentity: { device: sourceStat.dev.toString(), inode: sourceStat.ino.toString() },
    retirementName: params.retirementName,
    head,
    branch: params.branch,
    branchHead,
    indexSha256,
    index,
    ...(sharedIndex ? { sharedIndex } : {}),
    files,
  };
  const bytes = Buffer.from(JSON.stringify(metadata));
  await putBlob("manifest.json", bytes);
  return { metadata, digest: sha256(bytes), treeEntries, metadataEntries };
}

export async function writeExactStateCommit(
  cwd: string,
  captured: Awaited<ReturnType<typeof captureExactState>>,
) {
  const tree = await requireGit(cwd, ["mktree", "-z"], {
    input: Buffer.from(captured.metadataEntries.join("")),
  });
  return await requireGit(
    cwd,
    [
      "commit-tree",
      tree,
      "-p",
      captured.metadata.branchHead,
      "-m",
      "OpenClaw worktree exact state v1",
    ],
    { env: identity },
  );
}

export async function readExactStateSnapshot(
  cwd: string,
  snapshot: string,
  snapshotRef: string,
  options: Parameters<typeof requireGit>[2],
) {
  if (!snapshotRef.startsWith(exactSnapshotPrefix)) {
    if (snapshotRef.startsWith("refs/openclaw/snapshots/exact-")) {
      throw new Error(
        "Unsupported exact-state snapshot version; preserve the snapshot and use a compatible runtime",
      );
    }
    return undefined;
  }
  const metadata = metadataSchema.parse(
    JSON.parse(
      (await requireGitBuffer(cwd, ["show", `${snapshot}^2:manifest.json`], options)).toString(
        "utf8",
      ),
    ),
  );
  for (const file of metadata.files) {
    checkedPath(file.path);
  }
  if (
    (await requireGit(cwd, ["rev-parse", `${snapshot}^`], options)) !== metadata.head ||
    (await requireGit(cwd, ["rev-parse", `${snapshot}^2^`], options)) !== metadata.branchHead
  ) {
    throw new Error("Exact-state snapshot parent mismatch");
  }
  return metadata;
}

/** A receipt owns an incarnation, not arbitrary files added during an interrupted attempt. */
async function assertExactRestorePaths(
  cwd: string,
  metadata: ExactStateSnapshot,
  temporaryRoot: string,
  assertCurrent: () => void,
) {
  const allowed = new Set(metadata.files.map((entry) => entry.path));
  for (const entry of metadata.files) {
    const relative = checkedPath(entry.path);
    for (let slash = relative.indexOf(47); slash !== -1; slash = relative.indexOf(47, slash + 1)) {
      allowed.add(relative.subarray(0, slash).toString("hex"));
    }
  }
  const temporary = Buffer.from(path.basename(temporaryRoot));
  const pending = [Buffer.alloc(0)];
  while (pending.length) {
    const relative = pending.pop()!;
    assertCurrent();
    const entries = await fs.readdir(checkoutPathFromGitBytes(cwd, relative), {
      withFileTypes: true,
      encoding: "buffer",
    });
    for (const entry of entries) {
      if (
        !relative.length &&
        (entry.name.equals(Buffer.from(".git")) || entry.name.equals(temporary))
      ) {
        continue;
      }
      const child = relative.length
        ? Buffer.concat([relative, Buffer.from("/"), entry.name])
        : entry.name;
      if (!allowed.has(child.toString("hex"))) {
        throw new Error("Unexpected exact-state restore path; source and receipt preserved");
      }
      if (entry.isDirectory()) {
        pending.push(child);
      }
    }
  }
  assertCurrent();
}

/** Worktree bytes are materialized through the native source-only Git checkout; restore metadata last. */
export async function restoreExactStateMetadata(params: {
  checkoutPath: string;
  metadata: ExactStateSnapshot;
  options: Parameters<typeof requireGit>[2];
  assertCurrent: () => void;
  temporaryRoot: string;
}) {
  const { checkoutPath: cwd, metadata, options, assertCurrent } = params;
  await assertExactRestorePaths(cwd, metadata, params.temporaryRoot, assertCurrent);
  const temporaryFiles = path.join(params.temporaryRoot, "files");
  await fs.mkdir(temporaryFiles, { recursive: true });
  for (const entry of metadata.files
    .filter((file) => file.kind === "directory")
    .toSorted((a, b) => a.path.length - b.path.length)) {
    assertCurrent();
    const relative = checkedPath(entry.path);
    const assertParents = await checkParents(cwd, relative);
    assertCurrent();
    assertParents();
    fsSync.mkdirSync(checkoutPathFromGitBytes(cwd, relative), { recursive: true });
  }
  const rawFiles = metadata.files.filter(
    (entry) => !entry.provisioned && (entry.kind === "file" || entry.kind === "symlink"),
  );
  const algorithm = metadata.head.length === 64 ? "sha256" : "sha1";
  for (let offset = 0; offset < rawFiles.length;) {
    const batch: typeof rawFiles = [];
    let bytes = 0;
    while (
      offset < rawFiles.length &&
      (batch.length === 0 ||
        (batch.length < 128 && bytes + rawFiles[offset]!.size < 16 * 1024 * 1024))
    ) {
      const entry = rawFiles[offset++]!;
      if (!entry.blob) {
        throw new Error("Exact-state snapshot lacks file content");
      }
      batch.push(entry);
      bytes += entry.size;
    }
    const output = await requireGitBuffer(cwd, ["cat-file", "--batch"], {
      ...options,
      env: { ...options?.env, GIT_NO_REPLACE_OBJECTS: "1" },
      input: Buffer.from(batch.map((entry) => entry.blob).join("\n") + "\n"),
      maxOutputBytes: { stdout: bytes + batch.length * 128, stderr: 64 * 1024 },
      maxCombinedOutputBytes: bytes + batch.length * 128 + 64 * 1024,
    });
    let cursor = 0;
    for (const entry of batch) {
      const end = output.indexOf(10, cursor);
      const header = output.subarray(cursor, end).toString("ascii");
      if (end < cursor || header !== `${entry.blob} blob ${entry.size}`) {
        throw new Error("Exact-state file object mismatch");
      }
      const content = output.subarray(end + 1, end + 1 + entry.size);
      if (
        content.length !== entry.size ||
        output[end + 1 + entry.size] !== 10 ||
        blobOid(content, algorithm) !== entry.blob
      ) {
        throw new Error("Exact-state file content mismatch");
      }
      cursor = end + entry.size + 2;
      assertCurrent();
      const relative = checkedPath(entry.path);
      const assertParents = await checkParents(cwd, relative);
      const target = checkoutPathFromGitBytes(cwd, relative);
      const existing = await rawPathStat(target);
      if (existing) {
        const existingBytes =
          entry.kind === "symlink" && existing.isSymbolicLink()
            ? await fs.readlink(target, { encoding: "buffer" })
            : entry.kind === "file" && existing.isFile()
              ? await fs.readFile(target)
              : undefined;
        if (!existingBytes || !existingBytes.equals(content)) {
          throw new Error("Incomplete exact restore source changed; source and receipt preserved");
        }
        continue;
      }
      const temporary = path.join(
        temporaryFiles,
        createHash("sha256").update(entry.path).digest("hex"),
      );
      if (entry.kind === "symlink") {
        assertCurrent();
        assertParents();
        // Creating a symlink is already atomic and no-replace. Darwin link()
        // follows symlink sources, so a staged hard link cannot preserve it.
        fsSync.symlinkSync(content, target);
      } else {
        await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
        assertCurrent();
        assertParents();
        fsSync.linkSync(temporary, target);
        fsSync.unlinkSync(temporary);
      }
    }
    if (cursor !== output.length) {
      throw new Error("Unexpected trailing exact-state object bytes");
    }
  }
  // Children precede directories so the final directory timestamps survive file creation.
  for (const entry of metadata.files.toSorted((a, b) => b.path.length - a.path.length)) {
    assertCurrent();
    if (entry.kind === "missing") {
      const relative = checkedPath(entry.path);
      // A captured deletion can include the entire parent tree. Existing ancestors
      // must remain safe directories; absent ones must stay absent through this check.
      const assertParents = await checkParents(cwd, relative, true);
      const exists = await rawPathExists(checkoutPathFromGitBytes(cwd, relative));
      assertCurrent();
      assertParents();
      if (exists) {
        throw new Error("Captured missing exact-state path changed; source and receipt preserved");
      }
      continue;
    }
    const relative = checkedPath(entry.path);
    const assertParents = await checkParents(cwd, relative);
    const target = checkoutPathFromGitBytes(cwd, relative);
    const stat = await fs.lstat(target);
    const currentBytes =
      entry.kind === "symlink" && stat.isSymbolicLink()
        ? await fs.readlink(target, { encoding: "buffer" })
        : entry.kind === "file" && stat.isFile()
          ? await fs.readFile(target)
          : undefined;
    if (entry.blob && (!currentBytes || blobOid(currentBytes, algorithm) !== entry.blob)) {
      throw new Error("Exact-state restore bytes changed; source and receipt preserved");
    }
    assertCurrent();
    assertParents();
    const current = fsSync.lstatSync(target);
    if (entry.kind !== "directory" && current.nlink !== 1) {
      throw new Error("Exact-state restore hard-linked metadata target; source preserved");
    }
    if (current.dev !== stat.dev || current.ino !== stat.ino) {
      throw new Error("Exact-state metadata target changed; source preserved");
    }
    if (entry.kind === "symlink") {
      if (!stat.isSymbolicLink()) {
        throw new Error("Exact-state symlink restoration mismatch");
      }
      fsSync.lutimesSync(target, entry.mtimeMs / 1000, entry.mtimeMs / 1000);
    } else {
      if (entry.kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
        throw new Error("Exact-state file restoration mismatch");
      }
      if (process.platform !== "win32") {
        fsSync.chmodSync(target, entry.mode);
      }
      fsSync.utimesSync(target, entry.mtimeMs / 1000, entry.mtimeMs / 1000);
    }
  }
  await assertExactRestorePaths(cwd, metadata, params.temporaryRoot, assertCurrent);
  const destination = await indexPath(cwd);
  const atomicIndexFile = async (target: string, bytes: Buffer, mode: number, mtimeMs?: number) => {
    // Keep index.lock held by the caller; publish whole files without releasing
    // native Git exclusion before the registry commits the restored lifecycle.
    const temporary = target + ".openclaw-" + path.basename(params.temporaryRoot);
    assertCurrent();
    await fs.writeFile(temporary, bytes, { mode });
    if (process.platform !== "win32") {
      await fs.chmod(temporary, mode);
    }
    if (mtimeMs !== undefined) {
      await fs.utimes(temporary, mtimeMs / 1000, mtimeMs / 1000);
    }
    assertCurrent();
    await fs.rename(temporary, target);
  };
  if (metadata.sharedIndex) {
    const bytes = await requireGitBuffer(
      cwd,
      ["cat-file", "blob", metadata.sharedIndex.blob],
      options,
    );
    await atomicIndexFile(
      path.join(path.dirname(destination), metadata.sharedIndex.name),
      bytes,
      0o600,
    );
  }
  const index = await requireGitBuffer(cwd, ["cat-file", "blob", metadata.index.blob], options);
  if (sha256(index) !== metadata.indexSha256) {
    throw new Error("Exact-state index digest mismatch");
  }
  // This last atomic publication is the fallback materialization commit point.
  await atomicIndexFile(destination, index, metadata.index.mode, metadata.index.mtimeMs);
  assertCurrent();
}
