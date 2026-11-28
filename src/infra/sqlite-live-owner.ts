import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import {
  classifyGatewayLockProcessNamespace,
  GatewayLockNamespaceError,
  parseGatewayLockPayload,
} from "./gateway-lock-payload.js";
import { readOwnerPaths } from "./gateway-state-owner-lifecycle.js";
import { resolveGatewayStateOwnerPath } from "./gateway-state-owner.js";
import { readStateLeaseProcessOwnerStatus } from "./state-lease-process-owner.js";

// Only this database's recorded process identity can authorize native live reads.
export function hasVerifiedLiveSqliteOwner(
  databasePath: string,
  options?: { unknownOwner?: "return-false" },
): boolean {
  // Read admission already bound this path to live process custody; retirement clears it.
  if (readOwnerPaths.get(path.resolve(databasePath))?.accepting) {
    return true;
  }
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
  if (classifyGatewayLockProcessNamespace(owner, ownerPath) === "dead") {
    return false;
  }
  const ownerStatus = readStateLeaseProcessOwnerStatus({
    pid: owner.pid,
    host: owner.processNamespace?.host ?? hostname(),
    startedAt: owner.startTime ?? null,
    processNamespace: owner.processNamespace,
    machineIdentity: owner.machineIdentity,
  });
  if (ownerStatus === "unknown" && options?.unknownOwner !== "return-false") {
    throw new GatewayLockNamespaceError(owner, ownerPath);
  }
  return ownerStatus === "live";
}
