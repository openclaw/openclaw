import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { captureUpdateCommandExecutorAuthority } from "../cli/update-cli/update-command-executor.js";
import { hasErrnoCode } from "./errors.js";
import {
  openPackageActivationJournal,
  PACKAGE_ACTIVATION_JOURNAL,
  resolvePackageActivationAnchor,
} from "./package-update-activation-journal.js";
import { PACKAGE_ACTIVATION_HELPER } from "./package-update-activation-runtime-assets.js";
import { assertManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-database.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

/** Read-only correlation; callers still need a privately registered live fence. */
function readPackageActivationContinuation(installKey: string) {
  const anchor = resolvePackageActivationAnchor(installKey);
  try {
    fs.lstatSync(anchor);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  if (
    !fs.existsSync(path.join(anchor, PACKAGE_ACTIVATION_HELPER)) ||
    !fs.existsSync(path.join(anchor, PACKAGE_ACTIVATION_JOURNAL))
  ) {
    throw new Error(
      `Incomplete recovery artifacts require operator inspection: ${anchor}. The next mutable update is blocked.`,
    );
  }
  const record = openPackageActivationJournal(anchor).read();
  if (
    record.phase !== "publication-complete" ||
    record.descriptor.authority.installKey !== installKey
  ) {
    throw new Error("Package publication is incomplete; its original continuation cannot run.");
  }
  assertManagedUpdateLeaseDatabaseIdentity(record.descriptor.authority);
  return record.descriptor.authority;
}

export function assertNoPendingPackageActivation(
  installKey: string,
  options?: { continuation?: UpdateRecoveryFence },
): void {
  const authority = readPackageActivationContinuation(installKey);
  if (!authority) {
    return;
  }
  if (
    options?.continuation &&
    isDeepStrictEqual(authority, captureUpdateCommandExecutorAuthority(options.continuation))
  ) {
    return;
  }
  const anchor = resolvePackageActivationAnchor(installKey);
  throw new Error(
    `Package publication recovery is pending. Run an external Node with ${path.join(anchor, PACKAGE_ACTIVATION_HELPER)} status, then repair or retire; keep other package managers stopped.`,
  );
}
