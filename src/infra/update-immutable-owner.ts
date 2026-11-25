import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
} from "./package-update-activation-paths.js";
import type { ImmutableActivationOperation } from "./update-immutable-install-schema.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

/** All immutable writers share the native executor; its lease survives host reboot beside control. */
export async function withImmutableUpdateOwner<T>(
  root: string,
  run: (assertCurrent: () => void, fence: UpdateRecoveryFence) => Promise<T>,
  authority?: ImmutableActivationOperation["authority"],
  options?: { recover?: boolean },
): Promise<T> {
  const { withUpdateCommandExecutor } =
    await import("../cli/update-cli/update-command-executor.js");
  const control = resolvePackageActivationControl(resolvePackageActivationAnchor(root));
  const leasePath = path.join(control, "executor", "lease.sqlite");
  let pinned: Omit<ImmutableActivationOperation["authority"], "owner"> | undefined = authority;
  if (authority && authority.databasePath !== leasePath) {
    throw new Error("Immutable recovery executor does not match its installation control.");
  }
  if (!pinned && fs.existsSync(control)) {
    const stat = fs.lstatSync(control);
    if (
      !stat.isDirectory() ||
      stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 ||
      fs.realpathSync(control) !== control
    ) {
      throw new Error("Immutable executor control is not root-owned and protected.");
    }
    const { prepareManagedHandoffLeaseDatabase, captureManagedUpdateLeaseDatabaseIdentity } =
      await import("./update-managed-service-handoff-database.js");
    // Bootstrap the existing lease owner's schema before pinning it. The public
    // adoption record remains readable; only native executor metadata is private.
    if (!fs.existsSync(leasePath)) {
      (await prepareManagedHandoffLeaseDatabase(leasePath))(true, () => undefined);
    }
    pinned = {
      ...captureManagedUpdateLeaseDatabaseIdentity(leasePath),
      installKey: root,
    };
  }
  if (options?.recover && pinned) {
    const { recoverManagedUpdateLeaseJournal } =
      await import("./update-managed-service-handoff-database-recovery.js");
    await recoverManagedUpdateLeaseJournal({
      existingIdentity: pinned,
      installKey: root,
      serviceManagerEnv: process.env,
    });
  }
  return withUpdateCommandExecutor(
    randomUUID(),
    async (executor) => {
      const fence = await executor.enter(root);
      return run(fence.assertCurrent, fence);
    },
    pinned ? { existingAuthority: pinned } : undefined,
  );
}
