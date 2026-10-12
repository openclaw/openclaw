import fs from "node:fs";
import path from "node:path";
import type { Root } from "@openclaw/fs-safe";
import { sameFileIdentity, statRegularFileSync } from "@openclaw/fs-safe/advanced";
import { getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { FsSafeError, isNoReplaceUnsupported } from "@openclaw/fs-safe/errors";
import {
  pinDirectory,
  publishFileExclusive,
  requireDirectorySync,
  type PinnedDirectory,
} from "./directory-durability.js";
import { hasErrnoCode, isErrno } from "./errno.js";

type MigrationMoveRoot = Pick<
  Root,
  "rootReal" | "defaults" | "move" | "resolve" | "stat" | "open" | "remove" | "exists"
>;

export class LegacyMigrationMoveUnavailableError extends Error {
  constructor(
    readonly sourcePath: string,
    readonly code: string,
    cause: unknown,
  ) {
    super(`Filesystem cannot publish a no-replace hard-link move for ${sourcePath} (${code})`, {
      cause,
    });
    this.name = "LegacyMigrationMoveUnavailableError";
  }
}

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

async function pinMoveParent(root: MigrationMoveRoot, from: string): Promise<PinnedDirectory> {
  const relativePath = path.dirname(from);
  const parent = await pinDirectory(await root.resolve(relativePath));
  try {
    const admitted = await root.stat(relativePath);
    if (
      !admitted.isDirectory ||
      !sameFileIdentity(admitted.exactIdentity, parent.receipt.exactIdentity)
    ) {
      throw new FsSafeError("path-mismatch", "legacy migration source parent changed");
    }
    return parent;
  } catch (error) {
    await parent.close();
    throw error;
  }
}

export async function moveLegacyMigrationFileNoReplace(
  root: MigrationMoveRoot,
  from: string,
  to: string,
): Promise<void> {
  try {
    await root.move(from, to, {
      assertBeforeMutation: () => {
        // Root composes its default authority check and rechecks source identity after this.
        let source;
        try {
          source = statRegularFileSync(path.resolve(root.rootReal, from));
        } catch (cause) {
          if (isErrno(cause)) {
            throw cause;
          }
          throw new FsSafeError("invalid-path", "legacy migration move requires a regular file", {
            cause,
          });
        }
        if (source.missing) {
          throw new FsSafeError("not-found", "legacy migration source no longer exists");
        }
      },
    });
    return;
  } catch (error) {
    if (getFsSafeNativeConfig().mode === "require") {
      throw error;
    }
    if (isNoReplaceUnsupported(error)) {
      // fs-safe owns native fallback; preserve Doctor's recoverable refusal without retrying.
      throw new LegacyMigrationMoveUnavailableError(
        path.resolve(root.rootReal, from),
        error.code,
        error,
      );
    }
    // The portable publisher cannot revalidate mutation-specific Root policies.
    if (
      !(error instanceof FsSafeError) ||
      error.code !== "helper-unavailable" ||
      error.message !== "native fs-safe helper is unavailable" ||
      path.dirname(from) !== path.dirname(to) ||
      root.defaults.assertBeforeMutation ||
      root.defaults.denyMutations ||
      root.defaults.mutationSymlinks
    ) {
      throw error;
    }
  }
  const parent = await pinMoveParent(root, from);
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
      }).catch((error: unknown) => {
        // Post-publication failures are wrapped by fs-safe: only pre-publication
        // errno failures can safely defer without losing the original name.
        const code =
          !(error instanceof FsSafeError) &&
          ["EPERM", "EXDEV", "EMLINK", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].find((candidate) =>
            hasErrnoCode(error, candidate),
          );
        if (code) {
          throw new LegacyMigrationMoveUnavailableError(sourcePath, code, error);
        }
        throw error;
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

/** Recognize only an exact two-name regular-file publication, never arbitrary hardlinks. */
export async function inspectLegacyMigrationLinkedMove(
  root: MigrationMoveRoot,
  retained: string,
  removed: string,
): Promise<fs.BigIntStats | undefined> {
  if (
    path.dirname(retained) !== path.dirname(removed) ||
    path.resolve(root.rootReal, retained) === path.resolve(root.rootReal, removed)
  ) {
    throw new FsSafeError(
      "invalid-path",
      "legacy migration link recovery requires distinct sibling names",
    );
  }
  if (!(await root.exists(retained)) || !(await root.exists(removed))) {
    return undefined;
  }
  await using source = await root.open(retained, { hardlinks: "allow", symlinks: "reject" });
  await using target = await root.open(removed, { hardlinks: "allow", symlinks: "reject" });
  const identity = fs.fstatSync(source.handle.fd, { bigint: true });
  return isClaimLinkPair(identity, fs.fstatSync(target.handle.fd, { bigint: true }))
    ? identity
    : undefined;
}

/** Settle a known interrupted publication while retaining the caller-selected name. */
export async function recoverLegacyMigrationLinkedMove(
  root: MigrationMoveRoot,
  retained: string,
  removed: string,
): Promise<boolean> {
  const identity = await inspectLegacyMigrationLinkedMove(root, retained, removed);
  if (!identity) {
    return false;
  }
  const parent = await pinMoveParent(root, retained);
  try {
    {
      await using opened = await root.open(retained, { hardlinks: "allow", symlinks: "reject" });
      await opened.handle.sync();
    }
    requireDirectorySync(await parent.sync(), "Legacy migration recovery directory");
    await root.remove(removed, {
      assertBeforeMutation: () =>
        assertClaimLinkPair(
          path.join(parent.receipt.realPath, path.basename(retained)),
          path.join(parent.receipt.realPath, path.basename(removed)),
          identity,
        ),
    });
    requireDirectorySync(await parent.sync(), "Legacy migration recovery directory");
    return true;
  } finally {
    await parent.close();
  }
}
