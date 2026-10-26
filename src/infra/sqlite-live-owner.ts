import fs from "node:fs";
import { hostname } from "node:os";
import { GatewayLockNamespaceError, parseGatewayLockPayload } from "./gateway-lock-payload.js";
import { resolveGatewayStateOwnerPath } from "./gateway-state-owner.js";
import { readStateLeaseProcessOwnerStatus } from "./state-lease-process-owner.js";

// Only this database's recorded process identity can authorize native live reads.
export function hasVerifiedLiveSqliteOwner(databasePath: string): boolean {
  const ownerPath = resolveGatewayStateOwnerPath(databasePath);
  let owner;
  try {
    owner = parseGatewayLockPayload(fs.readFileSync(ownerPath, "utf8"));
  } catch {
    return false;
  }
  if (!owner || (owner.role && owner.role !== "gateway" && owner.role !== "agent-embedded")) {
    return false;
  }
  const ownerStatus = readStateLeaseProcessOwnerStatus({
    pid: owner.pid,
    host: owner.processNamespace?.host ?? hostname(),
    startedAt: owner.startTime ?? null,
    processNamespace: owner.processNamespace,
  });
  if (ownerStatus === "unknown") {
    throw new GatewayLockNamespaceError(owner, ownerPath);
  }
  return ownerStatus === "live";
}
