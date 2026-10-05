import {
  captureManagedUpdateLeaseDatabaseIdentity,
  type createManagedHandoffLeaseDatabase,
} from "./update-managed-service-handoff-database.js";
import type {
  BorrowedLegacyHandoffParent,
  LeaseAcquisition,
  ManagedHandoffLease,
  ManagedHandoffLeaseStoreOptions,
  ManagedHandoffParent,
} from "./update-managed-service-handoff-lease-types.js";
import type { ManagedHandoffOriginalAdmission } from "./update-managed-service-handoff-original-owner.js";
import type { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import type { createManagedHandoffLeaseRows } from "./update-managed-service-handoff-rows.js";
import { managedHandoffLeaseText as text } from "./update-managed-service-handoff-rows.js";
import {
  parseManagedHandoffLeasePayload,
  type ManagedHandoffLeaseAction,
} from "./update-managed-service-handoff-schema.js";

/** Cancellation-aware acquisition uses the original receiver admission transaction. */
export function createManagedHandoffOriginalAcquisition(deps: {
  options: ManagedHandoffLeaseStoreOptions;
  acquirePinnedOriginal: (
    pinnedOptions: ManagedHandoffLeaseStoreOptions,
    root: string,
    owner: string,
    action: ManagedHandoffLeaseAction,
  ) => LeaseAcquisition;
  withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>;
  processIdentity: ReturnType<typeof createManagedHandoffProcessIdentityReader>["processIdentity"];
  read: ReturnType<typeof createManagedHandoffLeaseRows>["read"];
  admit: (
    root: string,
    owner: string,
    payload: string,
    source?: ManagedHandoffLease,
    legacyParent?: BorrowedLegacyHandoffParent,
    originalParent?: ManagedHandoffParent,
  ) => LeaseAcquisition;
  originalUpdateAdmissions: WeakMap<ManagedHandoffLease, ManagedHandoffOriginalAdmission>;
}) {
  const {
    options,
    acquirePinnedOriginal,
    withDatabase,
    processIdentity,
    read,
    admit,
    originalUpdateAdmissions,
  } = deps;
  const { databasePath } = options;
  return function acquire(
    root: string,
    owner: string,
    requestedAction: ManagedHandoffLeaseAction,
    transition = false,
    legacyParent?: BorrowedLegacyHandoffParent,
    originalParent?: ManagedHandoffParent,
  ): LeaseAcquisition {
    let action = requestedAction;
    const originalUpdateOwner =
      options.originalUpdateKey === root &&
      !originalParent &&
      !legacyParent &&
      !transition &&
      !root.includes("/.openclaw-update-child-") &&
      action.kind === "update";
    if (originalUpdateOwner && action.kind === "update") {
      action = { ...action, mutationProtocol: "original-cancellation-v1" };
    }
    // Bootstrap storage without acquiring a row, then admit through the pinned
    // database owner. No path capture may fail or retarget authority after commit.
    if (originalUpdateOwner && !options.existingIdentity) {
      return withDatabase(true, () => {
        const existingIdentity = captureManagedUpdateLeaseDatabaseIdentity(databasePath);
        return acquirePinnedOriginal(
          { ...options, databasePath: existingIdentity.databasePath, existingIdentity },
          root,
          owner,
          action,
        );
      });
    }
    const helper = processIdentity();
    const mutationOriginal =
      !root.includes("/.openclaw-update-child-") &&
      originalParent?.version === 2 &&
      originalParent.action.kind === "update" &&
      originalParent.action.mutationProtocol === "original-cancellation-v1"
        ? {
            key: originalParent.key,
            owner: originalParent.owner,
            payload: originalParent.payload,
            updatedAt: originalParent.updatedAt,
          }
        : undefined;
    const payload = JSON.stringify({
      version: 2,
      executor: helper,
      helper,
      action,
      ...(mutationOriginal ? { mutationOriginal } : {}),
    });
    if (
      !text.safeParse(root).success ||
      !text.safeParse(owner).success ||
      !parseManagedHandoffLeasePayload(payload)
    ) {
      throw new Error("managed handoff admission is invalid");
    }
    if (transition) {
      if (legacyParent) {
        throw new Error("Borrowed legacy authority cannot transition a lease");
      }
      const result = read(root);
      if (
        result.kind !== "current" ||
        result.lease.owner !== owner ||
        result.lease.payload !== payload ||
        action.kind !== "triage" ||
        action.phase !== "reserved" ||
        action.lifetime.kind !== "native" ||
        action.lifetime.placement.kind !== "pending"
      ) {
        throw new Error("managed triage transition lost its current lease");
      }
      return { kind: "acquired", lease: result.lease };
    }
    const result = admit(root, owner, payload, undefined, legacyParent, originalParent);
    if (result.kind === "acquired" && originalUpdateOwner && options.existingIdentity) {
      const originalDatabaseIdentity = Object.freeze({ ...options.existingIdentity });
      originalUpdateAdmissions.set(result.lease, {
        database: originalDatabaseIdentity,
        original: structuredClone(result.lease),
      });
      // Carry the physical pin established before commit back to the live owner.
      // It must not recapture another inode or admit service rows through an
      // unpinned store after this original generation has been acquired.
      return { ...result, originalDatabaseIdentity };
    }
    return result;
  };
}
