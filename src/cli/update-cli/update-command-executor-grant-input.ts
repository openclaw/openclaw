import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-identity.js";
import type {
  ManagedHandoffLease,
  ManagedHandoffParent,
} from "../../infra/update-managed-service-handoff-lease-types.js";
import {
  isHandoffProcessIdentity,
  isManagedHandoffLeasePayload,
} from "../../infra/update-managed-service-handoff-schema.js";
import type { UpdateCommandChildGrant } from "./update-command-executor-children.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

function isLeaseRecord(value: unknown): value is ManagedHandoffParent {
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    typeof value.owner !== "string" ||
    typeof value.payload !== "string" ||
    typeof value.updatedAt !== "number" ||
    !Number.isSafeInteger(value.updatedAt) ||
    value.updatedAt < 0
  ) {
    return false;
  }
  if (value.version === 1) {
    return (
      isHandoffProcessIdentity(value.helper) &&
      isHandoffProcessIdentity(value.executor) &&
      isRecord(value.action) &&
      value.action.kind === "update"
    );
  }
  const { key: _key, owner: _owner, payload: _payload, updatedAt: _updatedAt, ...payload } = value;
  return isManagedHandoffLeasePayload(payload);
}

function isManagedLeaseRecord(value: unknown): value is ManagedHandoffLease {
  return isLeaseRecord(value) && value.version !== 1;
}

function isDatabaseIdentity(value: unknown): value is ManagedUpdateLeaseDatabaseIdentity {
  return (
    isRecord(value) &&
    typeof value.databasePath === "string" &&
    typeof value.databaseIdentity === "string" &&
    typeof value.parentIdentity === "string"
  );
}

function isSlot(value: unknown): value is NonNullable<UpdateCommandChildGrant["slot"]> {
  return (
    isRecord(value) &&
    isManagedLeaseRecord(value.parent) &&
    isManagedLeaseRecord(value.spawner) &&
    (!Object.hasOwn(value, "reserver") || isManagedLeaseRecord(value.reserver)) &&
    typeof value.childKey === "string"
  );
}

/** Admit private transport data before the executor checks its live owners. */
export function readUpdateCommandChildGrant(value: unknown): UpdateCommandChildGrant {
  if (!isRecord(value)) {
    throw new UpdateCommandRecoveryPendingError("Candidate executor grant is malformed.");
  }
  let slot: UpdateCommandChildGrant["slot"];
  if (Object.hasOwn(value, "slot")) {
    if (!isSlot(value.slot)) {
      throw new UpdateCommandRecoveryPendingError("Candidate occupied slot pair is malformed.");
    }
    slot = value.slot;
  }
  const retainedFields =
    Object.hasOwn(value, "retainedParent") || Object.hasOwn(value, "retainedChildKey");
  let retainedParent: UpdateCommandChildGrant["retainedParent"];
  let retainedChildKey: UpdateCommandChildGrant["retainedChildKey"];
  if (retainedFields) {
    if (!isManagedLeaseRecord(value.retainedParent) || typeof value.retainedChildKey !== "string") {
      throw new UpdateCommandRecoveryPendingError("Candidate retained owner pair is malformed.");
    }
    retainedParent = value.retainedParent;
    retainedChildKey = value.retainedChildKey;
  }
  if (
    typeof value.runId !== "string" ||
    typeof value.root !== "string" ||
    typeof value.databasePath !== "string" ||
    typeof value.childKey !== "string" ||
    !isLeaseRecord(value.parent) ||
    (value.originalParent !== undefined && !isLeaseRecord(value.originalParent)) ||
    (value.originalChildKey !== undefined && typeof value.originalChildKey !== "string") ||
    (value.spawner !== undefined && !isManagedLeaseRecord(value.spawner)) ||
    (value.databaseIdentity !== undefined && !isDatabaseIdentity(value.databaseIdentity))
  ) {
    throw new UpdateCommandRecoveryPendingError("Candidate executor grant is malformed.");
  }
  return {
    runId: value.runId,
    root: value.root,
    databasePath: value.databasePath,
    parent: value.parent,
    childKey: value.childKey,
    ...(value.originalParent !== undefined ? { originalParent: value.originalParent } : {}),
    ...(value.originalChildKey !== undefined ? { originalChildKey: value.originalChildKey } : {}),
    ...(value.spawner !== undefined ? { spawner: value.spawner } : {}),
    ...(value.databaseIdentity !== undefined ? { databaseIdentity: value.databaseIdentity } : {}),
    ...(slot ? { slot } : {}),
    ...(retainedParent ? { retainedParent, retainedChildKey } : {}),
  };
}
