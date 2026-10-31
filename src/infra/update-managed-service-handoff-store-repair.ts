// Owns recovery of an unusable managed-handoff lease store.
import fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "./errno.js";

/** Why a store could not be used, recorded on the retained copy and the warning. */
export type ManagedHandoffStoreDefect =
  | "unsafe-file"
  | "unsafe-directory"
  | "unreadable-database"
  | "undecodable-record";

/** Retain unusable coordination state for diagnostics before the caller provisions its replacement. */
export function quarantineManagedHandoffStore(
  databasePath: string,
  defect: ManagedHandoffStoreDefect,
  warn: (message: string) => void = (message) => console.warn(message),
): string | undefined {
  const retained = `${databasePath}.${defect}.${Date.now()}`;
  try {
    fs.renameSync(databasePath, retained);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    // Removing the blocker matters more than keeping a copy of it: a rename that
    // cannot land must not put the host back into a permanent refusal.
    try {
      fs.rmSync(databasePath, { force: true });
    } catch {
      return undefined;
    }
    warn(
      `[openclaw] managed handoff lease store was ${defect}; removed ${path.basename(databasePath)} to restore updates`,
    );
    return undefined;
  }
  warn(
    `[openclaw] managed handoff lease store was ${defect}; retained it as ${path.basename(retained)} and started a new one`,
  );
  return retained;
}
