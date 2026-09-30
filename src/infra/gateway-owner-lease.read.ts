import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { readOpenClawStateLease } from "../state/openclaw-state-lease-store.js";
import type {
  GatewayOwnerLeaseIdentity,
  GatewayOwnerSupervisor,
} from "./gateway-owner-lease.types.js";
import {
  parseStateLeaseProcessOwner,
  readStateLeaseProcessOwnerStatus,
} from "./state-lease-process-owner.js";

export const gatewayOwnerKey = { scope: "gateway-owner", key: "global" } as const;

function parseSupervisor(value: unknown): GatewayOwnerSupervisor | null {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    (value.kind !== "launchd" &&
      value.kind !== "systemd" &&
      value.kind !== "schtasks" &&
      value.kind !== "external") ||
    (value.name !== null && (typeof value.name !== "string" || !value.name.trim()))
  ) {
    throw new Error("Gateway owner lease supervisor could not be verified");
  }
  return { kind: value.kind, name: value.name };
}

/** Read through the caller's admitted connection when ownership guards a write. */
export function readGatewayOwnerLeaseFromDatabase(
  db: DatabaseSync,
  port?: number,
): GatewayOwnerLeaseIdentity | undefined {
  if (!tableExists(db, "state_leases")) {
    return undefined;
  }
  const row = readOpenClawStateLease(db, gatewayOwnerKey);
  if (!row) {
    return undefined;
  }
  const processOwner = parseStateLeaseProcessOwner(row.payloadJson);
  let payload: unknown;
  try {
    payload = row.payloadJson ? JSON.parse(row.payloadJson) : null;
  } catch {
    payload = null;
  }
  if (
    !processOwner ||
    !isRecord(payload) ||
    typeof payload.port !== "number" ||
    !Number.isInteger(payload.port) ||
    payload.port <= 0 ||
    payload.port > 65535 ||
    (payload.mode !== "foreground" && payload.mode !== "supervised")
  ) {
    throw new Error("Gateway owner lease identity could not be verified");
  }
  if (port !== undefined && payload.port !== port) {
    return undefined;
  }
  const supervisor = parseSupervisor(payload.supervisor);
  if ((payload.mode === "foreground") !== (supervisor === null)) {
    throw new Error("Gateway owner lease supervisor does not match its listener mode");
  }
  return {
    ...processOwner,
    owner: row.owner,
    port: payload.port,
    mode: payload.mode,
    supervisor,
    // Expiry cannot revoke the separate physical Gateway coordinator.
    state: readStateLeaseProcessOwnerStatus(processOwner),
    expired: row.expiresAt === null || row.expiresAt <= Date.now(),
  };
}
