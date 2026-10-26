import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { resolveServiceTmpDir } from "../daemon/service-tmp-dir.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "./update-managed-service-handoff-lease.js";

/** Earlier macOS Gateways kept leases under their state's TMPDIR; repair still reads it. */
export function resolveLegacyGatewayManagedUpdateLeaseDatabasePath(): string | undefined {
  const uid = process.getuid?.();
  const legacy = path.join(
    resolveServiceTmpDir(process.env, "darwin"),
    uid === undefined ? "openclaw" : `openclaw-${uid}`,
    "managed-update-handoffs.sqlite",
  );
  return process.platform === "darwin" && legacy !== resolveManagedUpdateLeaseDatabasePath()
    ? legacy
    : undefined;
}

/** Live or cancelled custody in an earlier Gateway's store fences admission until repaired. */
export function readLegacyGatewayCustodyRefusal(
  key: string,
  databasePath: string | undefined,
): string | undefined {
  if (!databasePath || !fs.existsSync(databasePath)) {
    return undefined;
  }
  const store = createManagedHandoffLeaseStore({
    databasePath,
    serviceManagerEnv: resolveServiceManagerEnv(),
  });
  const found = store.read(key);
  // Only owners proven gone release it; new writers never select this store again.
  const held =
    found.kind === "unreadable" ||
    store.hasUnsettledChildren(key) ||
    (found.kind === "current" &&
      (found.lease.version === 4 ||
        [found.lease.helper, found.lease.executor].some((owner) =>
          store.isProcessIdentityCurrent(owner),
        )));
  return held
    ? `Another update executor owns this installation in an earlier Gateway's handoff store (${databasePath}). If that update has exited, run ${formatCliCommand("openclaw update repair")} to settle it.`
    : undefined;
}
