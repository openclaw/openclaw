import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Root } from "@openclaw/fs-safe";
import { readRegularFileSync } from "@openclaw/fs-safe/advanced";
import { pathMayExistSync } from "./path-existence.js";
import {
  moveLegacyMigrationFileNoReplace,
  recoverLegacyMigrationLinkedMove,
} from "./state-migrations.no-replace-move.js";

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

  /** Roll back a link publication interrupted before its source name was removed. */
  async recoverLinkedMove(): Promise<void> {
    await recoverLegacyMigrationLinkedMove(
      this.params.stateRoot,
      this.sourceRelativePath,
      this.claimRelativePath,
    );
  }

  async recover(conflictMessage: string): Promise<void> {
    await this.recoverLinkedMove();
    if (!(await this.exists(true))) {
      return;
    }
    const claimed = await this.read(true);
    if (!(await this.exists())) {
      await moveLegacyMigrationFileNoReplace(
        this.params.stateRoot,
        this.claimRelativePath,
        this.sourceRelativePath,
      );
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
      await moveLegacyMigrationFileNoReplace(
        this.params.stateRoot,
        this.claimRelativePath,
        this.sourceRelativePath,
      );
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
    await moveLegacyMigrationFileNoReplace(
      this.params.stateRoot,
      this.sourceRelativePath,
      this.claimRelativePath,
    );
    const claimed = await this.read(true);
    if (!legacyMigrationSourceSnapshotsMatch(claimed, params.snapshot)) {
      throw new Error(params.mismatchMessage);
    }
    return claimed;
  }

  /** Drain both receipt-retired names through the caller's safe reader before removing them. */
  async removeRetiredSources(params: {
    readSnapshot?: (sourcePath: string) => Promise<LegacyMigrationSourceIdentity>;
    removeSource?: (sourcePath: string) => Promise<void> | void;
  }): Promise<number> {
    let removed = 0;
    for (const claimed of [false, true]) {
      if (!(await this.exists(claimed))) {
        continue;
      }
      const sourcePath = claimed ? this.claimPath : this.sourcePath;
      await (params.readSnapshot ?? this.params.readSnapshot)(sourcePath);
      if (params.removeSource) {
        await params.removeSource(sourcePath);
      } else {
        await this.params.stateRoot.remove(
          claimed ? this.claimRelativePath : this.sourceRelativePath,
        );
      }
      removed += 1;
    }
    return removed;
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
  beforeRestore?: () => void;
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
    try {
      params.beforeRestore?.();
      if (fs.existsSync(claimPath) && !fs.existsSync(params.sourcePath)) {
        fs.renameSync(claimPath, params.sourcePath);
      }
    } catch (restoreError) {
      restoreFailure = `; could not restore the claimed source at ${claimPath}: ${String(restoreError)}`;
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
