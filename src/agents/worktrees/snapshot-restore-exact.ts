import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hasErrnoCode } from "../../infra/errno.js";
import { root as fsRoot } from "../../infra/fs-safe.js";
import { rawPathStat } from "./git-path-inventory.js";
import { commandError, listGitWorktrees, requireGit, requireGitBuffer, runGit } from "./git.js";
import { restoreProvisionedFiles } from "./provisioned-files.js";
import {
  assertExactStateSourceIdentity,
  hasExactWorktreeIndex,
  requireExactManagedWorktreeHead,
  requireExactWorktreeRepository,
  withExactStateGitLocks,
} from "./removal-git.js";
import { restoreExactStateMetadata, type ExactStateSnapshot } from "./snapshot-exact-state.js";
import type { ManagedWorktreeRecord, ProvisionedFileState } from "./types.js";

type GitOptions = Parameters<typeof runGit>[2];
const oid = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
const receiptSchema = z
  .object({
    version: z.literal(1),
    binding: z.string().regex(/^[a-f0-9]{64}$/u),
    snapshot: oid,
    nonce: z.string().uuid(),
    sourceIdentity: z
      .object({
        device: z.string().regex(/^\d+$/u),
        inode: z.string().regex(/^\d+$/u),
      })
      .strict(),
  })
  .strict();
type Receipt = z.infer<typeof receiptSchema> & { commit: string };
const receiptRef = (record: ManagedWorktreeRecord) =>
  "refs/openclaw/restores/exact-v1/" + record.id;
const binding = (record: ManagedWorktreeRecord) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        record.id,
        record.createdAt,
        record.ownerKind,
        record.ownerId,
        record.repoRoot,
        record.path,
        record.branch,
      ]),
    )
    .digest("hex");

/** A native Git receipt pins the immutable snapshot and the newly allocated inode before checkout. */
export async function readExactRestoreReceipt(
  record: ManagedWorktreeRecord,
  options: GitOptions,
): Promise<Receipt | undefined> {
  const found = await runGit(
    record.repoRoot,
    ["rev-parse", "--verify", "--quiet", receiptRef(record) + "^{commit}"],
    options,
  );
  if (found.code === 1) {
    return undefined;
  }
  if (found.code !== 0) {
    throw commandError("git rev-parse exact restore", found);
  }
  const commit = found.stdout.trim();
  const receipt = receiptSchema.parse(
    JSON.parse(
      (
        await requireGitBuffer(record.repoRoot, ["show", commit + ":manifest.json"], options)
      ).toString("utf8"),
    ),
  );
  if (
    receipt.binding !== binding(record) ||
    (await requireGit(record.repoRoot, ["rev-parse", commit + "^"], options)) !== receipt.snapshot
  ) {
    throw new Error("Exact restore receipt ownership changed; source and snapshot preserved");
  }
  return { ...receipt, commit };
}

export async function clearExactRestoreReceipt(
  record: ManagedWorktreeRecord,
  receipt: Receipt,
  options: GitOptions,
) {
  await requireGit(
    record.repoRoot,
    ["update-ref", "-d", receiptRef(record), receipt.commit],
    options,
  );
}

async function createReceipt(
  record: ManagedWorktreeRecord,
  snapshot: string,
  options: GitOptions,
): Promise<Receipt> {
  options?.beforeRun?.();
  await fs.mkdir(path.dirname(record.path), { recursive: true });
  // Native Git permits an empty pre-existing destination. This also recovers a
  // crash between directory allocation and receipt publication without adopting data.
  await fs.mkdir(record.path).catch((error: unknown) => {
    if (!hasErrnoCode(error, "EEXIST")) {
      throw error;
    }
  });
  if (
    (await fs.readdir(record.path)).length ||
    (await listGitWorktrees(record.repoRoot)).some((entry) => entry.path === record.path)
  ) {
    throw new Error("Exact restore destination is occupied; source and snapshot preserved");
  }
  const stat = await fs.lstat(record.path, { bigint: true });
  if (!stat.isDirectory()) {
    throw new Error("Exact restore destination is not a directory");
  }
  const receipt = {
    version: 1 as const,
    binding: binding(record),
    snapshot,
    nonce: randomUUID(),
    sourceIdentity: { device: stat.dev.toString(), inode: stat.ino.toString() },
  };
  const blob = await requireGit(record.repoRoot, ["hash-object", "-w", "--stdin"], {
    ...options,
    input: Buffer.from(JSON.stringify(receipt)),
  });
  const tree = await requireGit(record.repoRoot, ["mktree", "-z"], {
    ...options,
    input: Buffer.from("100644 blob " + blob + "\tmanifest.json\0"),
  });
  const commit = await requireGit(
    record.repoRoot,
    ["commit-tree", tree, "-p", snapshot, "-m", "OpenClaw exact restore v1"],
    {
      ...options,
      env: {
        ...options?.env,
        GIT_AUTHOR_NAME: "OpenClaw",
        GIT_AUTHOR_EMAIL: "openclaw@localhost",
        GIT_COMMITTER_NAME: "OpenClaw",
        GIT_COMMITTER_EMAIL: "openclaw@localhost",
      },
    },
  );
  await requireGit(
    record.repoRoot,
    ["update-ref", receiptRef(record), commit, "0".repeat(snapshot.length)],
    options,
  );
  return { ...receipt, commit };
}

async function restoreProvisionedAtomically(params: {
  env: NodeJS.ProcessEnv;
  record: ManagedWorktreeRecord;
  metadata: ExactStateSnapshot;
  states: readonly ProvisionedFileState[];
  temporaryRoot: string;
  assertCurrent: () => void;
}) {
  const { record, metadata, temporaryRoot, assertCurrent } = params;
  const root = path.join(temporaryRoot, "provisioned");
  await fs.mkdir(root, { recursive: true });
  await restoreProvisionedFiles(params.env, record.id, root, params.states, assertCurrent);
  const [sourceRoot, destinationRoot] = await Promise.all([fsRoot(root), fsRoot(record.path)]);
  for (const state of params.states) {
    assertCurrent();
    const target = path.join(record.path, state.path);
    const entry = metadata.files.find(
      (file) => file.provisioned && Buffer.from(file.path, "hex").toString("utf8") === state.path,
    );
    if (!entry) {
      throw new Error("Exact restore lacks provisioned metadata");
    }
    const existing = await rawPathStat(target);
    if (existing) {
      if (!existing.isFile() || state.mode === null) {
        throw new Error("Exact restore provisioned path changed; source preserved");
      }
      const opened = await destinationRoot.open(target, { hardlinks: "allow" });
      try {
        const digest = createHash(metadata.head.length === 64 ? "sha256" : "sha1").update(
          "blob " + opened.stat.size + "\0",
        );
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (;;) {
          const { bytesRead } = await opened.handle.read(buffer);
          if (!bytesRead) {
            break;
          }
          digest.update(buffer.subarray(0, bytesRead));
          assertCurrent();
        }
        if (digest.digest("hex") !== entry.blob) {
          throw new Error("Exact restore provisioned bytes changed; source preserved");
        }
      } finally {
        await opened.handle.close();
      }
    } else if (state.mode !== null) {
      await destinationRoot.copyIn(
        target,
        { root: sourceRoot, relativePath: path.join(root, state.path) },
        {
          overwrite: false,
          maxBytes: Infinity,
          preserveSourceMode: true,
          sourceHardlinks: "allow",
          mutationSymlinks: "reject",
          durable: false,
          assertBeforeMutation: assertCurrent,
        },
      );
    }
  }
}

/** Resume only the receipt-owned incarnation; keep it and the snapshot on any interrupted attempt. */
export async function restoreExactSnapshotFallback<T>(params: {
  record: ManagedWorktreeRecord;
  snapshot: string;
  metadata: ExactStateSnapshot;
  env: NodeJS.ProcessEnv;
  states: readonly ProvisionedFileState[];
  options: GitOptions;
  assertCurrent: () => void;
  add: (assertCurrent: () => void) => Promise<void>;
  finalize: (identity: ExactStateSnapshot) => Promise<T>;
}) {
  const { record, snapshot, metadata } = params;
  const receipt =
    (await readExactRestoreReceipt(record, params.options)) ??
    (await createReceipt(record, snapshot, params.options));
  if (receipt.snapshot !== snapshot) {
    throw new Error("Exact restore snapshot changed; receipt and source preserved");
  }
  const identity = { ...metadata, sourceIdentity: receipt.sourceIdentity };
  const assertCurrent = () => {
    params.assertCurrent();
    assertExactStateSourceIdentity(record.path, identity);
  };
  const options = { ...params.options, beforeRun: assertCurrent };
  assertCurrent();
  if (!(await listGitWorktrees(record.repoRoot)).some((entry) => entry.path === record.path)) {
    if ((await fs.readdir(record.path)).length) {
      throw new Error("Incomplete exact restore registration; source and receipt preserved");
    }
    assertCurrent();
    await params.add(assertCurrent);
  }
  await requireExactWorktreeRepository(record, record.path, options);
  return await withExactStateGitLocks(record, assertCurrent, async () => {
    await requireExactManagedWorktreeHead(
      { ...record, removedAt: undefined },
      {
        ownerKind: record.ownerKind,
        ownerId: record.ownerId,
        createdAt: record.createdAt,
        lastActiveAt: record.lastActiveAt,
        head: metadata.head,
        branchHead: metadata.branchHead,
        indexSha256: metadata.indexSha256,
      },
      options,
    );
    const temporaryRoot = path.join(record.path, ".openclaw-restore-" + receipt.nonce);
    if (
      metadata.files.some(
        (entry) =>
          Buffer.from(entry.path, "hex").toString("utf8").split("/")[0] ===
          path.basename(temporaryRoot),
      )
    ) {
      throw new Error("Exact restore temporary namespace conflicts with captured data");
    }
    if (!(await hasExactWorktreeIndex(record.path, metadata, options))) {
      assertCurrent();
      await fs.rm(temporaryRoot, { recursive: true, force: true });
      await restoreProvisionedAtomically({
        env: params.env,
        record,
        metadata,
        states: params.states,
        temporaryRoot,
        assertCurrent,
      });
      await restoreExactStateMetadata({
        checkoutPath: record.path,
        metadata,
        options,
        assertCurrent,
        temporaryRoot,
      });
    }
    assertCurrent();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    assertCurrent();
    const result = await params.finalize(identity);
    await clearExactRestoreReceipt(record, receipt, options);
    return result;
  });
}
