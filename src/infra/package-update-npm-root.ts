import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "./errors.js";
import {
  createPackageIntegrityReader,
  type PackageDirectoryIdentity,
  type PackageRootIntegrityFingerprint,
} from "./package-update-integrity.js";
import { matchesStandaloneGitWrapper } from "./update-git-launcher.js";
import { verifyGitUpdateRecovery, type GitRuntimeIdentity } from "./update-git-runtime.js";

/** Retain a Git runtime identity only after its package link or launcher backup proves ownership. */
export async function verifyRetainedNpmGitRuntime(params: {
  previous?: GitRuntimeIdentity;
  native: boolean;
  targetSwapRoot: string;
  previousRoot?: PackageRootIntegrityFingerprint;
  shims: ReadonlyArray<{ backup: string | null }>;
}): Promise<GitRuntimeIdentity | undefined> {
  const previous = params.previous;
  if (!previous) {
    return undefined;
  }
  const sourceLink =
    params.previousRoot?.kind === "link" &&
    path.resolve(path.dirname(params.targetSwapRoot), params.previousRoot.target) === previous.root;
  const sourceWrappers = await Promise.all(
    params.shims.map(async (shim) => {
      if (!shim.backup) {
        return false;
      }
      const stat = await fs.lstat(shim.backup);
      return (
        stat.isFile() &&
        stat.size <= 4096 &&
        (await matchesStandaloneGitWrapper(
          await fs.readFile(shim.backup, "utf8"),
          previous.root,
          process.platform,
          process.execPath,
        ))
      );
    }),
  );
  if (
    params.native ||
    (!sourceLink && !sourceWrappers.some(Boolean)) ||
    !(await verifyGitUpdateRecovery(previous)).serviceRestartSafe
  ) {
    throw new Error("Previous Git runtime does not own the retained CLI launcher.");
  }
  return previous;
}

export function createNpmPackageRootLinkLifecycle(params: {
  liveRoot: string;
  backupRoot: string;
  fingerprint: Extract<PackageRootIntegrityFingerprint, { kind: "link" }>;
  timeoutMs?: number;
}) {
  const assertUnchanged = async (root: string) => {
    const actual = await createPackageIntegrityReader(params.timeoutMs).rootEntry(
      root,
      params.liveRoot,
      "link",
    );
    if (!isDeepStrictEqual(actual, params.fingerprint)) {
      throw new Error("Npm package link changed before activation or retirement");
    }
  };
  return {
    assertLiveUnchanged: () => assertUnchanged(params.liveRoot),
    async acquire(): Promise<{ acquired: true } | { acquired: false; error: string }> {
      await fs.rename(params.liveRoot, params.backupRoot);
      try {
        // Only the moved entry can establish ownership of the retained link.
        await assertUnchanged(params.backupRoot);
        return { acquired: true };
      } catch (error) {
        // A mismatch already disproves ownership. Do not compensate into a
        // live path where another package publisher may now be writing.
        return {
          acquired: false,
          error: `Npm package link backup refused: ${formatErrorMessage(error)}; moved entry retained at ${params.backupRoot}; inspect it before manual recovery`,
        };
      }
    },
    async retire(assertCurrent = () => {}): Promise<string | null> {
      try {
        assertCurrent();
        await assertUnchanged(params.backupRoot);
        // This observation does not exclude concurrent writers. Non-recursive
        // removal protects a substituted directory and the external checkout.
        assertCurrent();
        await fs.unlink(params.backupRoot);
        return null;
      } catch (error) {
        assertCurrent();
        return `Could not retire retained npm package link at ${params.backupRoot}: ${formatErrorMessage(error)}`;
      }
    },
  };
}

/** Verify the same retained/restored npm root and launcher baseline without inference. */
export async function verifyNpmRootRecovery(
  params: {
    root: string;
    fromBackup: boolean;
    hadPackage: boolean;
    previousRoot: PackageRootIntegrityFingerprint | undefined;
    previousIdentity?: PackageDirectoryIdentity;
    targetSwapRoot: string;
    shims: readonly { destination: string; backup: string | null; fingerprint?: string }[];
  },
  timeoutMs?: number,
): Promise<void> {
  const { root, fromBackup, hadPackage, previousRoot, targetSwapRoot, shims } = params;
  const reader = createPackageIntegrityReader(timeoutMs);
  await reader.observe(fromBackup ? "retained" : "restored", async () => {
    if (
      hadPackage
        ? previousRoot
          ? !isDeepStrictEqual(
              await reader.rootEntry(root, targetSwapRoot, previousRoot.kind),
              previousRoot,
            )
          : !params.previousIdentity ||
            !isDeepStrictEqual(await reader.directoryIdentity(root), params.previousIdentity)
        : !fromBackup && (await reader.exists(root))
    ) {
      throw new Error(
        `Package rollback verification failed: retained package ${previousRoot?.kind === "link" ? "link" : "tree"} changed`,
      );
    }
    for (const shim of shims) {
      const target = fromBackup ? shim.backup : shim.destination;
      if (
        shim.backup
          ? !target || (await reader.launcher(target)) !== shim.fingerprint
          : !fromBackup && (await reader.exists(shim.destination))
      ) {
        throw new Error(
          `Package rollback verification failed: launcher ${shim.destination} changed`,
        );
      }
    }
  });
}
