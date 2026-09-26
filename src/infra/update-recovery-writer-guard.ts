import { AsyncLocalStorage } from "node:async_hooks";
import {
  resolveUpdateRecoveryRuntimeRoot,
  updateRecoveryStartupLocation,
} from "./update-recovery-startup-location.js";

const nativeWriter = new AsyncLocalStorage<() => void>();
let startupAdmission: (() => void) | undefined;

/** Only entry's verified original/candidate selection installs this assertion.
 * It is rechecked for every writer; an observed pathname is not a grant. */
export function admitUpdateRecoveryStartupWriters(assertCurrent: () => void): void {
  if (startupAdmission) {
    throw new Error("Recovery startup admission is already installed.");
  }
  assertCurrent();
  startupAdmission = assertCurrent;
}

/** The real original native executor supplies this lexical assertion. Child
 * processes do not inherit it, and retired/cancelled native owners must refuse. */
export function withUpdateRecoveryWriterAuthority<T>(
  assertNative: () => void,
  operation: () => T,
): T {
  return nativeWriter.run(assertNative, operation);
}

/** Read-only opens still require the caller's normal immutable/read admission.
 * This gate does not broaden them or let a request/env flag authorize writes. */
export function assertUpdateRecoveryWriterAllowed(): void {
  // Read-only discovery workers import SQLite without acquiring a writer and
  // may live in an independently emitted package. Do not inspect writer
  // identity at module load; a writer must still resolve and verify it here.
  const root = resolveUpdateRecoveryRuntimeRoot(import.meta.url);
  if (!root) {
    return;
  } // Standalone sealed helpers have their own native owner.
  const location = updateRecoveryStartupLocation(root);
  if (location.retained) {
    throw new Error("A retained original runtime cannot acquire a state writer.");
  }
  if (!location.present) {
    return;
  }
  const authority = nativeWriter.getStore() ?? startupAdmission;
  if (!authority) {
    throw new Error(
      "Pending package recovery requires verified startup or original native custody.",
    );
  }
  authority();
}
