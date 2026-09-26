import fs from "node:fs";
import path from "node:path";
import type { UpdateInitialStoreTransport } from "../../infra/update-initial-store-transport.js";
import type { ManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { ChildOperation, ChildPurpose } from "./update-command-executor-children.js";

export type ManagedUpdateLeaseAuthority = ManagedUpdateLeaseDatabaseIdentity &
  Readonly<{ installKey: string; owner: string }>;
export const admittedAuthorities = new WeakMap<
  UpdateRecoveryFence,
  {
    authority: ManagedUpdateLeaseAuthority;
    assertCurrent: () => void;
    assertPublicationCurrent?: () => void;
    currentStores?: () => UpdateInitialStoreTransport;
    managedHandoff: boolean;
  }
>();
export const admittedRunIds = new WeakMap<UpdateRecoveryFence, string>();
export const retainedOwners = new WeakMap<UpdateRecoveryFence, string>();

export const preflightReleases = new WeakMap<UpdateRecoveryFence, () => void>();
export const slotReservations = new WeakMap<UpdateRecoveryFence, (root: string) => void>();
export function occupiedSlotKey(root: string): string {
  const absolute = path.resolve(root);
  return path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
}

export const childOwners = new WeakMap<
  UpdateRecoveryFence,
  <T>(root: string, operation: ChildOperation<T>, purpose?: ChildPurpose) => Promise<T>
>();

export const originalCancellations = new WeakMap<
  UpdateRecoveryFence,
  (runId: string, cause: Error) => void
>();
