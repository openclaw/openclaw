import fs from "node:fs";
import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  type createManagedHandoffLeaseDatabase,
} from "./update-managed-service-handoff-database.js";
import type {
  LeaseAcquisition,
  ManagedHandoffLease,
  ManagedHandoffLeaseStoreOptions,
  ManagedHandoffParent,
} from "./update-managed-service-handoff-lease-types.js";
import type { BorrowedLegacyHandoffParent } from "./update-managed-service-handoff-legacy-parent.js";
import {
  readManagedHandoffDescendant,
  type ManagedHandoffOriginalAdmission,
} from "./update-managed-service-handoff-original-owner.js";
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
  transact: <T>(db: HandoffDatabase, run: () => T) => T;
  processIdentity: ReturnType<typeof createManagedHandoffProcessIdentityReader>["processIdentity"];
  read: ReturnType<typeof createManagedHandoffLeaseRows>["read"];
  admit: (
    root: string,
    owner: string,
    payload: string,
    source?: ManagedHandoffLease,
    legacyParent?: BorrowedLegacyHandoffParent,
    originalParent?: ManagedHandoffParent,
    admissionDatabase?: HandoffDatabase,
  ) => LeaseAcquisition;
  originalUpdateAdmissions: WeakMap<ManagedHandoffLease, ManagedHandoffOriginalAdmission>;
}): (
  root: string,
  owner: string,
  action: ManagedHandoffLeaseAction,
  transition?: boolean,
  legacyParent?: BorrowedLegacyHandoffParent,
  originalParent?: ManagedHandoffParent,
) => LeaseAcquisition {
  const {
    options,
    acquirePinnedOriginal,
    withDatabase,
    transact,
    processIdentity,
    read,
    admit,
    originalUpdateAdmissions,
  } = deps;
  const { databasePath, originalUpdateRetainedKey } = options;
  function acquire(
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
    let result: LeaseAcquisition;
    if (originalUpdateOwner && originalUpdateRetainedKey !== undefined) {
      const retainedRoot = originalUpdateRetainedKey;
      if (
        retainedRoot === root ||
        retainedRoot.includes("/.openclaw-update-child-") ||
        fs.realpathSync(root) !== root ||
        fs.realpathSync(retainedRoot) !== retainedRoot
      ) {
        throw new Error("Original retained update root is invalid");
      }
      // Both admissions use one pinned connection/transaction. A busy second
      // root rolls back the first; no release/reacquire gap or orphan authority.
      let busy: Extract<LeaseAcquisition, { kind: "busy" }> | undefined;
      const refused = new Error("Original retained update pair is busy");
      try {
        result = withDatabase(true, (db) =>
          transact(db, () => {
            const unsettled =
              readManagedHandoffDescendant(root, db) ??
              readManagedHandoffDescendant(retainedRoot, db);
            if (unsettled) {
              busy = { kind: "busy", owner: unsettled.owner };
              throw refused;
            }
            const original = admit(root, owner, payload, undefined, undefined, undefined, db);
            if (original.kind !== "acquired") {
              busy = original;
              throw refused;
            }
            const retained = admit(
              retainedRoot,
              owner,
              payload,
              undefined,
              undefined,
              undefined,
              db,
            );
            if (retained.kind !== "acquired") {
              busy = retained;
              throw refused;
            }
            return { ...original, retainedLease: retained.lease };
          }),
        );
      } catch (error) {
        if (error !== refused || !busy) {
          throw error;
        }
        return busy;
      }
    } else {
      result = admit(root, owner, payload, undefined, legacyParent, originalParent);
    }
    if (result.kind === "acquired" && originalUpdateOwner && options.existingIdentity) {
      const originalDatabaseIdentity = Object.freeze({ ...options.existingIdentity });
      originalUpdateAdmissions.set(result.lease, {
        database: originalDatabaseIdentity,
        original: structuredClone(result.lease),
        current: structuredClone(result.lease),
        ...(result.retainedLease
          ? {
              retainedSelection: result.retainedLease.key,
              retained: {
                original: structuredClone(result.retainedLease),
                current: structuredClone(result.retainedLease),
              },
            }
          : {}),
      });
      // Carry the physical pin established before commit back to the live owner.
      // It must not recapture another inode or admit service rows through an
      // unpinned store after this original generation has been acquired.
      return { ...result, originalDatabaseIdentity };
    }
    return result;
  }
  return acquire;
}
