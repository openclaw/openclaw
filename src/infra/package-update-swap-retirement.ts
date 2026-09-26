import {
  discardPackageUpdateBackup,
  discardPackageLauncherBackup,
  type PackageLauncherBackup,
} from "./package-update-filesystem.js";
import type { PackageRootIntegrityFingerprint } from "./package-update-integrity.js";
import type { createNpmPackageRootLinkLifecycle } from "./package-update-npm-root.js";
import type { UpdateStepResult } from "./update-step-result.js";

/** Called only by the verified, cached transaction completion path. */
export async function retireVerifiedPackageSwap(params: {
  activation: { retire: () => Promise<unknown> } | undefined;
  rootLink: Awaited<ReturnType<typeof createNpmPackageRootLinkLifecycle>> | undefined;
  hadPackage: boolean;
  previousRoot: PackageRootIntegrityFingerprint | undefined;
  backupRoot: string;
  launchers: PackageLauncherBackup;
  packageBackedUp: boolean;
  globalRoot: string;
  assertCurrent: () => void;
  step: (
    exitCode: number,
    stdoutTail: string | null,
    stderrTail: string | null,
  ) => UpdateStepResult;
}): Promise<UpdateStepResult | undefined> {
  const {
    activation,
    rootLink,
    hadPackage,
    previousRoot,
    backupRoot,
    launchers,
    packageBackedUp,
    assertCurrent,
    step,
  } = params;
  const messages: string[] = [];
  // The filesystem fallback can recheck an assertion after catching it.
  // A later successful read cannot turn that authority failure into cleanup.
  let assertionFailure: { cause: unknown } | undefined;
  const assertRetirementCurrent = () => {
    if (assertionFailure) {
      throw assertionFailure.cause;
    }
    try {
      assertCurrent();
    } catch (cause) {
      assertionFailure = { cause };
      throw cause;
    }
  };
  if (activation) {
    await activation.retire();
    // The journal has removed itself; only the executor fence remains.
    assertRetirementCurrent();
    return undefined;
  }
  const linkRetention =
    rootLink && packageBackedUp ? await rootLink.retire(assertRetirementCurrent) : null;
  assertRetirementCurrent();
  if (linkRetention) {
    return { ...step(1, null, linkRetention), name: "package-backup-retention" };
  }
  if (hadPackage && previousRoot?.kind !== "link") {
    const message = await discardPackageUpdateBackup(
      backupRoot,
      "old package",
      params.globalRoot,
      assertRetirementCurrent,
    );
    if (message) {
      messages.push(message);
    }
  }
  const launcherCleanup = await discardPackageLauncherBackup(
    launchers,
    params.globalRoot,
    assertRetirementCurrent,
  );
  if (launcherCleanup) {
    messages.push(launcherCleanup);
  }
  // Capture authority loss during the final filesystem await in the
  // retirement outcome, not only in the caller's later publication check.
  assertRetirementCurrent();
  if (messages.length) {
    return {
      ...step(1, null, messages.join("\n")),
      name: "package-backup-retention",
      // Only this verified obsolete-resource path qualifies the warning.
      // Recovery refusal and unclassified link outcomes remain hard.
      advisory: {
        kind: "recoverable-maintenance" as const,
        message: `Installation verification succeeded; backup cleanup remains pending. ${messages.join("\n")}. Inspect retained paths before removing obsolete backups manually.`,
      },
    };
  }
  return undefined;
}
