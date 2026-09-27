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

/**
 * Coordination state for updates lives in a shared temp directory, so anything
 * that lands there — an interrupted first write, an operator clearing the file,
 * a half-written page — used to refuse config mutation and native service
 * operations for every install root on the host, permanently and with no
 * in-product recovery. Updates cannot have a state that ends that way.
 *
 * Retain the evidence instead of trusting or deleting it: move the store aside
 * under a name that records the defect, and let the caller open a fresh one. The
 * retained copy keeps whatever diagnostics the failure left behind, while nothing
 * inside it is read back or believed.
 */
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
