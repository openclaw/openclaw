import fs from "node:fs";
import path from "node:path";
import {
  isPackageActivationComplete,
  openPackageActivationJournal,
  packageActivationIdentity,
} from "./package-update-activation-journal.js";
import { updateRecoveryStartupLocation } from "./update-recovery-startup-location.js";
import { admitUpdateRecoveryStartupWriters } from "./update-recovery-writer-guard.js";

function isReadOnlyDatabasePreflight(argv: readonly string[]): boolean {
  const args = argv.slice(2);
  const databasePath = args[2];
  return (
    (args.length === 4 &&
      args[0] === "database" &&
      args[1] === "preflight" &&
      typeof databasePath === "string" &&
      path.isAbsolute(databasePath) &&
      args[3] === "--json") ||
    (args.length === 6 &&
      args[0] === "database" &&
      args[1] === "preflight-agent" &&
      typeof databasePath === "string" &&
      path.isAbsolute(databasePath) &&
      args[3] === "--agent-id" &&
      Boolean(args[4]) &&
      args[5] === "--json")
  );
}

/** Admit ordinary startup only for a settled forward or reverse publication.
 * A retained runtime may execute only its shipped read-only copied-database
 * preflight; it never receives writer admission or a new recovery command. */
export async function enterUpdateRecoveryStartup(params: {
  installRoot: string;
  entryFile: string;
  argv: readonly string[];
}): Promise<boolean> {
  void params.entryFile;
  const location = updateRecoveryStartupLocation(params.installRoot);
  if (location.retained) {
    if (!isReadOnlyDatabasePreflight(params.argv)) {
      throw new Error("Retained original runtime is recovery-inspection only.");
    }
    const journal = openPackageActivationJournal(location.anchor);
    const record = journal.read();
    if (
      !record.descriptor.originalRunId ||
      !record.descriptor.previousRuntime ||
      ![
        "publication-complete",
        "reverse-preparing",
        "reverse-in-progress",
        "reverse-complete",
        "rolled-back",
      ].includes(record.phase) ||
      fs.realpathSync(params.installRoot) !== params.installRoot ||
      packageActivationIdentity(params.installRoot, true) !== record.descriptor.previous.identity
    ) {
      throw new Error("Retained original runtime is not the selected recovery image.");
    }
    journal.assertCurrent(record);
    return false;
  }
  if (!location.present) {
    return false;
  }
  const journal = openPackageActivationJournal(location.anchor);
  const record = journal.read();
  const identity = packageActivationIdentity(params.installRoot, true);
  const settledForward =
    record.phase === "publication-complete" &&
    record.descriptor.reverse === undefined &&
    identity === record.descriptor.candidate.identity;
  const settledReverse =
    record.phase === "rolled-back" &&
    record.descriptor.reverse !== undefined &&
    identity === record.descriptor.previous.identity;
  const selectedOriginalPreflight =
    isReadOnlyDatabasePreflight(params.argv) &&
    record.descriptor.reverse !== undefined &&
    ["reverse-in-progress", "reverse-complete", "rolled-back"].includes(record.phase) &&
    identity === record.descriptor.previous.identity;
  if (
    record.descriptor.authority.installKey !== params.installRoot ||
    fs.realpathSync(params.installRoot) !== params.installRoot ||
    (!isPackageActivationComplete(location.anchor, record) &&
      !settledForward &&
      !settledReverse &&
      !selectedOriginalPreflight) ||
    ![record.descriptor.previous.identity, record.descriptor.candidate.identity].includes(identity)
  ) {
    throw new Error("Package/state recovery is incomplete; use its retained recovery helper.");
  }
  if (selectedOriginalPreflight) {
    journal.assertCurrent(record);
    return false;
  }
  admitUpdateRecoveryStartupWriters(() => {
    journal.assertCurrent(record);
    if (packageActivationIdentity(params.installRoot, true) !== identity) {
      throw new Error("Startup writer runtime selection changed.");
    }
  });
  return false;
}
