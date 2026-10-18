import fs from "node:fs";
import { shortenHomePath } from "../utils.js";
import {
  archiveAuthProfileMigrationSource,
  inspectTerminalAuthProfileMigrationArchive,
  type AuthProfileMigrationSourceReceipt,
} from "./doctor-auth-migration-receipts.js";

export function finishPreviouslyMigratedAuthProfileSource(
  receipt: AuthProfileMigrationSourceReceipt,
): string | null {
  const previousArchive = inspectTerminalAuthProfileMigrationArchive(receipt);
  if (previousArchive.status === "not-terminal") {
    return null;
  }
  if (previousArchive.status === "verified") {
    fs.unlinkSync(receipt.sourcePath);
    return `Removed a previously migrated legacy auth source because its existing archive was verified (${shortenHomePath(previousArchive.archivePath)}).`;
  }
  archiveAuthProfileMigrationSource(receipt);
  return `Archived a previously migrated legacy auth source without replaying credentials (${shortenHomePath(receipt.archivePath)}).`;
}
