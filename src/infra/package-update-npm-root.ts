import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "./errors.js";
import {
  createPackageIntegrityReader,
  type PackageDirectoryIdentity,
  type PackageRootIntegrityFingerprint,
} from "./package-update-integrity.js";
import { readCurrentGitUpdateRecovery } from "./update-runner-git-recovery.js";

/** The retained package link owns this baseline; its checkout remains operator-owned. */
async function captureNpmLinkedGitRecovery(
  packageRoot: string,
  link: Extract<PackageRootIntegrityFingerprint, { kind: "link" }>,
  timeoutMs?: number,
): Promise<(() => Promise<void>) | undefined> {
  const target = path.resolve(path.dirname(packageRoot), link.target);
  const recovery = await readCurrentGitUpdateRecovery(target, timeoutMs);
  if (!recovery.serviceRestartSafe || !recovery.buildId) {
    return undefined;
  }
  const root = await fs.realpath(target);
  const identity = await fs.stat(root, { bigint: true });
  if (identity.ino === 0n || (process.platform === "win32" && identity.dev === 0n)) {
    return undefined;
  }
  return async () => {
    const currentIdentity = await fs.stat(root, { bigint: true });
    const current = await readCurrentGitUpdateRecovery(root, timeoutMs);
    const verifiedIdentity = await fs.stat(root, { bigint: true });
    if (
      (await fs.realpath(target)) !== root ||
      currentIdentity.dev !== identity.dev ||
      currentIdentity.ino !== identity.ino ||
      verifiedIdentity.dev !== identity.dev ||
      verifiedIdentity.ino !== identity.ino ||
      !current.serviceRestartSafe ||
      current.buildId !== recovery.buildId ||
      current.version !== recovery.version
    ) {
      throw new Error("Previous Git runtime changed; automatic rollback was refused.");
    }
  };
}

export async function createNpmPackageRootLinkLifecycle(params: {
  liveRoot: string;
  backupRoot: string;
  fingerprint: Extract<PackageRootIntegrityFingerprint, { kind: "link" }>;
  timeoutMs?: number;
}) {
  const verifyRuntime = await captureNpmLinkedGitRecovery(
    params.liveRoot,
    params.fingerprint,
    params.timeoutMs,
  );
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
    verifyRuntime,
    async assertLiveUnchanged() {
      await assertUnchanged(params.liveRoot);
      await verifyRuntime?.();
    },
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
  verifyGitRuntime?: () => Promise<void>,
): Promise<boolean> {
  const { root, fromBackup, hadPackage, previousRoot, targetSwapRoot, shims } = params;
  const reader = createPackageIntegrityReader(timeoutMs);
  return await reader.observe(fromBackup ? "retained" : "restored", async () => {
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
        `Package rollback verification failed: ${fromBackup ? "retained" : "restored"} package ${previousRoot?.kind === "link" ? "link" : "tree"} changed at ${root}. Inspect this ${fromBackup ? "backup" : "installation"} and resolve the changes before retrying recovery.`,
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
    await verifyGitRuntime?.();
    // Restoring absence or an unverified external link does not establish a runnable runtime.
    return (
      hadPackage &&
      (previousRoot?.kind === "directory" ||
        verifyGitRuntime !== undefined ||
        (!previousRoot && params.previousIdentity !== undefined))
    );
  });
}
