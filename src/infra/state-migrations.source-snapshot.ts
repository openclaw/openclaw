import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Root } from "@openclaw/fs-safe";
import { readRegularFileSync } from "@openclaw/fs-safe/advanced";
import { getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import {
  pinDirectory,
  publishFileExclusive,
  requireDirectorySync,
  type PinnedDirectory,
} from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { pathMayExistSync } from "./path-existence.js";

/** The stable source identity every doctor-owned import verifies before cleanup. */
export type LegacyMigrationSourceSnapshot = {
  buffer: Buffer;
  dev: number;
  ino: number;
  mtimeMs: number;
  raw: string;
  sha256: string;
  size: number;
  sourcePath: string;
};

type LegacyMigrationSourceIdentity = Pick<
  LegacyMigrationSourceSnapshot,
  "dev" | "ino" | "mtimeMs" | "sha256" | "size" | "sourcePath"
>;

function isClaimLinkPair(source: fs.BigIntStats, claim: fs.BigIntStats): boolean {
  return (
    source.isFile() &&
    claim.isFile() &&
    source.nlink === 2n &&
    claim.nlink === 2n &&
    source.dev === claim.dev &&
    source.ino === claim.ino
  );
}

function assertClaimLinkPair(
  sourcePath: string,
  claimPath: string,
  identity: fs.BigIntStats,
): void {
  const source = fs.lstatSync(sourcePath, { bigint: true });
  const claim = fs.lstatSync(claimPath, { bigint: true });
  if (
    !isClaimLinkPair(source, claim) ||
    source.dev !== identity.dev ||
    source.ino !== identity.ino
  ) {
    throw new FsSafeError("path-mismatch", "legacy migration source/claim link pair changed");
  }
}

/** Keep every claim operation bound to the same trusted owner root and source inode. */
export class LegacyMigrationSourceClaim<
  TSnapshot extends LegacyMigrationSourceIdentity = LegacyMigrationSourceSnapshot,
> {
  readonly sourcePath: string;
  readonly claimPath: string;
  readonly sourceRelativePath: string;
  readonly claimRelativePath: string;

  constructor(
    private readonly params: {
      stateRoot: Root;
      stateDir: string;
      sourcePath: string;
      label: string;
      claimSuffix?: string;
      readSnapshot: (sourcePath: string) => Promise<TSnapshot>;
      formatError?: (error: unknown) => string;
      includeFilePath?: boolean;
    },
  ) {
    this.sourcePath = params.sourcePath;
    this.claimPath = `${params.sourcePath}${params.claimSuffix ?? ".doctor-importing"}`;
    this.sourceRelativePath = resolveLegacyMigrationRelativePath(
      params.stateDir,
      this.sourcePath,
      params.label,
      params.includeFilePath,
    );
    this.claimRelativePath = resolveLegacyMigrationRelativePath(
      params.stateDir,
      this.claimPath,
      params.label,
      params.includeFilePath,
    );
  }

  async exists(claimed = false): Promise<boolean> {
    return await this.params.stateRoot.exists(
      claimed ? this.claimRelativePath : this.sourceRelativePath,
    );
  }

  async read(claimed = false): Promise<TSnapshot> {
    return await this.params.readSnapshot(claimed ? this.claimPath : this.sourcePath);
  }

  private async pinParent(): Promise<PinnedDirectory> {
    const relativePath = path.dirname(this.sourceRelativePath);
    const parent = await pinDirectory(await this.params.stateRoot.resolve(relativePath));
    try {
      const admitted = await this.params.stateRoot.stat(relativePath);
      if (
        !admitted.isDirectory ||
        admitted.dev !== parent.receipt.identity.dev ||
        admitted.ino !== parent.receipt.identity.ino
      ) {
        throw new FsSafeError("path-mismatch", "legacy migration source parent changed");
      }
      return parent;
    } catch (error) {
      await parent.close();
      throw error;
    }
  }

  private async move(from: string, to: string): Promise<void> {
    const root = this.params.stateRoot;
    try {
      await root.move(from, to);
      return;
    } catch (error) {
      // The portable publisher cannot revalidate mutation-specific Root policies.
      if (
        !(error instanceof FsSafeError) ||
        error.code !== "helper-unavailable" ||
        getFsSafeNativeConfig().mode === "require" ||
        path.dirname(from) !== path.dirname(to) ||
        root.defaults.assertBeforeMutation ||
        root.defaults.denyMutations ||
        root.defaults.mutationSymlinks ||
        (error.cause !== undefined &&
          !["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].some((code) =>
            hasErrnoCode(error.cause, code),
          ))
      ) {
        throw error;
      }
    }
    const parent = await this.pinParent();
    try {
      const sourcePath = path.join(parent.receipt.realPath, path.basename(from));
      const targetPath = path.join(parent.receipt.realPath, path.basename(to));
      let identity: fs.BigIntStats;
      {
        // Close before unlink: FUSE can retain an open source as a .fuse_hidden hardlink.
        await using opened = await root.open(from, { hardlinks: "reject", symlinks: "reject" });
        identity = fs.fstatSync(opened.handle.fd, { bigint: true });
        await opened.handle.sync();
        const published = await publishFileExclusive({
          sourcePath,
          targetPath,
          expectedSourceIdentity: identity,
          parentReceipt: parent.receipt,
          strategy: "link-required",
        });
        requireDirectorySync(published.directorySync, "Legacy migration claim directory");
      }
      await root.remove(from, {
        assertBeforeMutation: () => assertClaimLinkPair(sourcePath, targetPath, identity),
      });
      requireDirectorySync(await parent.sync(), "Legacy migration source directory");
    } finally {
      await parent.close();
    }
  }

  /** Roll back a link publication interrupted before its source name was removed. */
  async recoverLinkedMove(): Promise<void> {
    if (!(await this.exists()) || !(await this.exists(true))) {
      return;
    }
    const root = this.params.stateRoot;
    const parent = await this.pinParent();
    try {
      let identity: fs.BigIntStats | undefined;
      {
        await using source = await root.open(this.sourceRelativePath, {
          hardlinks: "allow",
          symlinks: "reject",
        });
        await using claim = await root.open(this.claimRelativePath, {
          hardlinks: "allow",
          symlinks: "reject",
        });
        const sourceStat = fs.fstatSync(source.handle.fd, { bigint: true });
        if (isClaimLinkPair(sourceStat, fs.fstatSync(claim.handle.fd, { bigint: true }))) {
          await source.handle.sync();
          identity = sourceStat;
        }
      }
      if (!identity) {
        return;
      }
      requireDirectorySync(await parent.sync(), "Legacy migration recovery directory");
      const retainedIdentity = identity;
      await root.remove(this.claimRelativePath, {
        assertBeforeMutation: () =>
          assertClaimLinkPair(
            path.join(parent.receipt.realPath, path.basename(this.sourceRelativePath)),
            path.join(parent.receipt.realPath, path.basename(this.claimRelativePath)),
            retainedIdentity,
          ),
      });
      requireDirectorySync(await parent.sync(), "Legacy migration recovery directory");
    } finally {
      await parent.close();
    }
  }

  async recover(conflictMessage: string): Promise<void> {
    await this.recoverLinkedMove();
    if (!(await this.exists(true))) {
      return;
    }
    const claimed = await this.read(true);
    if (!(await this.exists())) {
      await this.move(this.claimRelativePath, this.sourceRelativePath);
      return;
    }
    if (!legacyMigrationSourceContentMatches(claimed, await this.read())) {
      throw new Error(conflictMessage);
    }
    await this.params.stateRoot.remove(this.claimRelativePath);
  }

  async restore(): Promise<string | null> {
    try {
      await this.recoverLinkedMove();
      if (!(await this.exists(true))) {
        return null;
      }
      if (await this.exists()) {
        return `source path already exists: ${this.sourcePath}`;
      }
      await this.move(this.claimRelativePath, this.sourceRelativePath);
      return null;
    } catch (error) {
      return this.params.formatError?.(error) ?? String(error);
    }
  }

  async claim(params: {
    snapshot: TSnapshot;
    mismatchMessage: string;
    beforeClaim?: () => void;
  }): Promise<TSnapshot> {
    params.beforeClaim?.();
    await this.move(this.sourceRelativePath, this.claimRelativePath);
    const claimed = await this.read(true);
    if (!legacyMigrationSourceSnapshotsMatch(claimed, params.snapshot)) {
      throw new Error(params.mismatchMessage);
    }
    return claimed;
  }

  async remove(
    params: {
      removeSource?: (sourcePath: string) => Promise<void> | void;
      sourceReappearedMessage?: string;
      remainingMessage?: string;
      sourceRemainingMessage?: string;
      claimRemainingMessage?: string;
      skipSourceCheck?: boolean;
    } = {},
  ): Promise<void> {
    if (!params.skipSourceCheck && (await this.exists())) {
      throw new Error(
        params.sourceReappearedMessage ??
          `legacy source reappeared during import: ${this.sourcePath}`,
      );
    }
    if (params.removeSource) {
      await params.removeSource(this.claimPath);
    } else {
      await this.params.stateRoot.remove(this.claimRelativePath);
    }
    const sourceRemainingMessage = params.sourceRemainingMessage ?? params.remainingMessage;
    if (sourceRemainingMessage && (await this.exists())) {
      throw new Error(sourceRemainingMessage);
    }
    const claimRemainingMessage = params.claimRemainingMessage ?? params.remainingMessage;
    if (claimRemainingMessage && (await this.exists(true))) {
      throw new Error(claimRemainingMessage);
    }
  }
}

/** Restore claimed sources in reverse order so a failed multi-file import remains atomic. */
export async function restoreLegacyMigrationSourceClaims<
  TSnapshot extends LegacyMigrationSourceIdentity,
>(claims: readonly LegacyMigrationSourceClaim<TSnapshot>[]): Promise<string[]> {
  const errors: string[] = [];
  for (const claim of claims.toReversed()) {
    const error = await claim.restore();
    if (error) {
      errors.push(error);
    }
  }
  return errors;
}

/** Claim every source before SQLite writes; restore the full batch on the first mismatch. */
export async function claimLegacyMigrationSourceClaims<
  TSnapshot extends LegacyMigrationSourceIdentity,
>(
  claims: readonly { claim: LegacyMigrationSourceClaim<TSnapshot>; snapshot: TSnapshot }[],
  params: { beforeClaim?: () => void; mismatchMessage: string },
): Promise<void> {
  params.beforeClaim?.();
  const claimed: LegacyMigrationSourceClaim<TSnapshot>[] = [];
  try {
    for (const { claim, snapshot } of claims) {
      claimed.push(claim);
      await claim.claim({ snapshot, mismatchMessage: params.mismatchMessage });
    }
  } catch (error) {
    const restoreErrors = await restoreLegacyMigrationSourceClaims(claimed);
    throw new Error(
      `${String(error)}${restoreErrors.length > 0 ? `; restore failures: ${restoreErrors.join("; ")}` : ""}`,
      { cause: error },
    );
  }
}

export function legacyMigrationSourceOrClaimMayExist(
  sourcePath: string,
  claimSuffix = ".doctor-importing",
): boolean {
  return pathMayExistSync(sourcePath) || pathMayExistSync(`${sourcePath}${claimSuffix}`);
}

/** Constrain migration reads and moves to the original trusted state root. */
export function resolveLegacyMigrationRelativePath(
  stateDir: string,
  filePath: string,
  label: string,
  includeFilePath = true,
): string {
  const relativePath = path.relative(path.resolve(stateDir), path.resolve(filePath));
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(
      `legacy ${label} path is outside the state directory${includeFilePath ? `: ${filePath}` : ""}`,
    );
  }
  return relativePath;
}

/** Hash the exact bounded bytes returned by the symlink/hardlink-safe root. */
export async function readLegacyMigrationSourceSnapshot(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
  maxBytes: number;
  label: string;
  hashDecodedText?: boolean;
}): Promise<LegacyMigrationSourceSnapshot> {
  const opened = await params.stateRoot.read(
    resolveLegacyMigrationRelativePath(params.stateDir, params.sourcePath, params.label),
    { hardlinks: "reject", maxBytes: params.maxBytes, symlinks: "reject" },
  );
  const raw = opened.buffer.toString("utf8");
  return {
    buffer: opened.buffer,
    dev: opened.stat.dev,
    ino: opened.stat.ino,
    mtimeMs: opened.stat.mtimeMs,
    raw,
    sha256: createHash("sha256")
      .update(params.hashDecodedText ? raw : opened.buffer)
      .digest("hex"),
    size: opened.buffer.byteLength,
    sourcePath: params.sourcePath,
  };
}

/** Read admitted legacy bytes; claim and cleanup owners verify the retained snapshot. */
export function readLegacyMigrationSourceSnapshotSync(params: {
  sourcePath: string;
  label: string;
  followSymlinks?: boolean;
  maxBytes?: number;
}): LegacyMigrationSourceSnapshot {
  const { buffer, stat } = readRegularFileSync({
    filePath: params.followSymlinks ? fs.realpathSync(params.sourcePath) : params.sourcePath,
    maxBytes: params.maxBytes,
  });
  const raw = buffer.toString("utf8");
  return {
    buffer: Buffer.from(raw),
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    raw,
    sha256: createHash("sha256").update(raw).digest("hex"),
    size: buffer.byteLength,
    sourcePath: params.sourcePath,
  };
}

/** Check source identity again before committing or deleting a verified import. */
export function assertLegacyMigrationSourceUnchanged(params: {
  sourcePath: string;
  snapshot: LegacyMigrationSourceSnapshot;
  label: string;
  followSymlinks?: boolean;
  maxBytes?: number;
}): void {
  if (
    !legacyMigrationSourceSnapshotsMatch(
      readLegacyMigrationSourceSnapshotSync(params),
      params.snapshot,
    )
  ) {
    throw new Error(`legacy ${params.label} source changed after doctor loaded it`);
  }
}

/** Restore a claimed legacy source when verified cleanup cannot complete. */
export function claimAndRemoveLegacyMigrationSource(params: {
  sourcePath: string;
  snapshot: LegacyMigrationSourceSnapshot;
  label: string;
  followSymlinks?: boolean;
  maxBytes?: number;
  beforeClaim?: () => void;
  removeSource?: (sourcePath: string) => void;
}): void {
  params.beforeClaim?.();
  const claimPath = `${params.sourcePath}.doctor-importing-${process.pid}-${randomUUID()}`;
  fs.renameSync(params.sourcePath, claimPath);
  try {
    const claimed = readLegacyMigrationSourceSnapshotSync({ ...params, sourcePath: claimPath });
    if (!legacyMigrationSourceSnapshotsMatch(claimed, params.snapshot)) {
      throw new Error(`legacy ${params.label} source changed before doctor could claim it`);
    }
    (params.removeSource ?? fs.unlinkSync)(claimPath);
  } catch (error) {
    let restoreFailure = "";
    if (fs.existsSync(claimPath) && !fs.existsSync(params.sourcePath)) {
      try {
        fs.renameSync(claimPath, params.sourcePath);
      } catch (restoreError) {
        restoreFailure = `; the claimed source remains at ${claimPath} because restore also failed: ${String(restoreError)}`;
      }
    }
    throw new Error(`${String(error)}${restoreFailure}`, { cause: error });
  }
}

export function legacyMigrationSourceSnapshotsMatch(
  left: Pick<LegacyMigrationSourceSnapshot, "dev" | "ino" | "mtimeMs" | "sha256" | "size">,
  right: Pick<LegacyMigrationSourceSnapshot, "dev" | "ino" | "mtimeMs" | "sha256" | "size">,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

function legacyMigrationSourceContentMatches(
  left: Pick<LegacyMigrationSourceSnapshot, "sha256" | "size">,
  right: Pick<LegacyMigrationSourceSnapshot, "sha256" | "size">,
): boolean {
  return left.sha256 === right.sha256 && left.size === right.size;
}
