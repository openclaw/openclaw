import fs from "node:fs";
import { hostname } from "node:os";
import { parseGatewayLockPayload, type LockPayload } from "./gateway-lock-payload.js";
import { resolveStateOwnerIdentity } from "./gateway-state-owner-directory.js";
import { readStateLeaseProcessOwnerStatus } from "./state-lease-process-owner.js";

/** This is read-source evidence only; it does not lend the Gateway's authority. */
export function hasVerifiedLiveSqliteOwner(databasePath: string): boolean {
  const { canonicalPath, ownerPath } = resolveStateOwnerIdentity(databasePath);
  // Startup may publish ownership before opening the WAL family. Do not let a
  // read-only inspection create missing sidecars in that case.
  if (!fs.existsSync(`${canonicalPath}-wal`) || !fs.existsSync(`${canonicalPath}-shm`)) {
    return false;
  }
  let owner: LockPayload | null;
  try {
    owner = parseGatewayLockPayload(fs.readFileSync(ownerPath, "utf8"));
  } catch {
    return false;
  }
  return (
    owner !== null &&
    (owner.role === "gateway" || owner.role === "agent-embedded") &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    readStateLeaseProcessOwnerStatus({
      pid: owner.pid,
      host: owner.processNamespace?.host ?? hostname(),
      startedAt: owner.startTime ?? null,
      processNamespace: owner.processNamespace,
    }) === "live"
  );
}
