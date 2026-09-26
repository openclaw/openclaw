import { createHash } from "node:crypto";
import syncFs from "node:fs";
import { FsSafeError, type Root } from "../infra/fs-safe.js";

function digestOpenFile(fd: number, expected: syncFs.BigIntStats, label: string): string {
  const before = syncFs.fstatSync(fd, { bigint: true });
  if (
    !before.isFile() ||
    before.dev !== expected.dev ||
    before.ino !== expected.ino ||
    before.birthtimeNs !== expected.birthtimeNs ||
    before.size !== expected.size ||
    before.mtimeNs !== expected.mtimeNs ||
    before.ctimeNs !== expected.ctimeNs
  ) {
    throw new Error(`Claw workspace ${label} identity changed during no-replace move fallback.`);
  }
  const digest = createHash("sha256").update(syncFs.readFileSync(fd)).digest("hex");
  const after = syncFs.fstatSync(fd, { bigint: true });
  if (
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs
  ) {
    throw new Error(`Claw workspace ${label} changed during no-replace move fallback.`);
  }
  return digest;
}

/** Moves one admitted workspace file without replacement when the native helper is unavailable. */
export async function moveClawWorkspaceFileNoReplace(
  workspace: Root,
  from: string,
  to: string,
  assertCurrent: () => void,
  options: { copyFallback?: boolean } = {},
): Promise<void> {
  try {
    await workspace.move(from, to, {
      overwrite: false,
      assertBeforeMutation: assertCurrent,
    });
    return;
  } catch (error) {
    if (!(error instanceof FsSafeError) || error.code !== "helper-unavailable") {
      throw error;
    }
    if (options.copyFallback === false) {
      throw error;
    }
  }

  // Root.move's no-replace contract requires the optional native helper. Preserve the same
  // semantics through Root.copyIn's exclusive, root-bounded publication, then unlink the exact
  // source only while both pathname identities still match this operation's receipts.
  const opened = await workspace.open(from, { hardlinks: "reject", symlinks: "reject" });
  const sourcePath = opened.realPath;
  const sourceIdentity = syncFs.fstatSync(opened.handle.fd, { bigint: true });
  const sourceDigest = digestOpenFile(opened.handle.fd, sourceIdentity, "source");
  let targetIdentity: Readonly<{ path: string; dev: bigint; ino: bigint }> | undefined;
  const assertSourceIdentity = () => {
    const source = syncFs.lstatSync(sourcePath, { bigint: true });
    if (
      !source.isFile() ||
      source.dev !== sourceIdentity.dev ||
      source.ino !== sourceIdentity.ino ||
      source.birthtimeNs !== sourceIdentity.birthtimeNs ||
      source.size !== sourceIdentity.size ||
      source.mtimeNs !== sourceIdentity.mtimeNs ||
      source.ctimeNs !== sourceIdentity.ctimeNs
    ) {
      throw new Error("Claw workspace source identity changed during no-replace move fallback.");
    }
  };
  const assertCopyIdentity = () => {
    assertSourceIdentity();
    if (!targetIdentity) {
      throw new Error("Claw workspace copy publication identity is missing.");
    }
    const target = syncFs.lstatSync(targetIdentity.path, { bigint: true });
    if (
      !target.isFile() ||
      target.dev !== targetIdentity.dev ||
      target.ino !== targetIdentity.ino
    ) {
      throw new Error("Claw workspace target identity changed during no-replace move fallback.");
    }
    const targetFd = syncFs.openSync(targetIdentity.path, "r");
    try {
      const openedTarget = syncFs.fstatSync(targetFd, { bigint: true });
      if (
        openedTarget.dev !== targetIdentity.dev ||
        openedTarget.ino !== targetIdentity.ino ||
        digestOpenFile(targetFd, openedTarget, "target") !== sourceDigest
      ) {
        throw new Error("Claw workspace target content changed during no-replace move fallback.");
      }
    } finally {
      syncFs.closeSync(targetFd);
    }
  };
  const assertOwnedCopy = () => {
    assertCurrent();
    assertCopyIdentity();
  };
  try {
    assertCurrent();
    await workspace.copyIn(
      to,
      { root: workspace, relativePath: from },
      {
        assertBeforeMutation: () => {
          assertCurrent();
          assertSourceIdentity();
        },
        clone: "never",
        overwrite: false,
        sourceHardlinks: "reject",
        onDestinationPublished: (receipt) => {
          targetIdentity = receipt;
        },
      },
    );
    if (!targetIdentity) {
      throw new Error("Claw workspace copy publication did not report its destination identity.");
    }
    try {
      await workspace.remove(from, { assertBeforeMutation: assertOwnedCopy });
    } catch (error) {
      try {
        // Publication already happened, but a later owner may have edited that object in place.
        // Without current mutation authority, preserve the copy for explicit reconciliation.
        await workspace.remove(to, { assertBeforeMutation: assertOwnedCopy });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Could not roll back the no-replace move fallback from ${from} to ${to}.`,
          { cause: cleanupError },
        );
      }
      throw error;
    }
  } finally {
    await opened[Symbol.asyncDispose]();
  }
}
