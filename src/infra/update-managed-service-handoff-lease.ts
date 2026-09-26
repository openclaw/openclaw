import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import { hasErrnoCode } from "./errno.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import type { SqliteTransactionOptions } from "./sqlite-transaction.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import { createManagedHandoffBootIdentityReader } from "./update-managed-service-handoff-boot.js";
import { createManagedHandoffCancellation } from "./update-managed-service-handoff-cancellation.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "./update-managed-service-handoff-database.js";
import type {
  LeaseAcquisition,
  ManagedHandoffLease,
  ManagedHandoffLeaseStoreOptions,
  ManagedHandoffParent,
} from "./update-managed-service-handoff-lease-types.js";
import {
  readBorrowedLegacyHandoffParent,
  type BorrowedLegacyHandoffParent,
} from "./update-managed-service-handoff-legacy-parent.js";
import { createManagedHandoffMutationReader } from "./update-managed-service-handoff-mutation.js";
import { createManagedHandoffOriginalAcquisition } from "./update-managed-service-handoff-original-acquisition.js";
import {
  createManagedHandoffOriginalOwner,
  hasOriginalUpdateExecutorCustody,
  readOriginalUpdateDependents,
  type ManagedHandoffOriginalAdmission,
} from "./update-managed-service-handoff-original-owner.js";
import { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import {
  observeManagedHandoffOriginalReclamation,
  readManagedHandoffAdmissionLease as admissionLease,
} from "./update-managed-service-handoff-reclamation.js";
import { assertNoRetainedSourceBorrower } from "./update-managed-service-handoff-retained-custody.js";
import {
  createManagedHandoffLeaseRows,
  managedHandoffLeaseText as text,
  triageFailureSchema,
} from "./update-managed-service-handoff-rows.js";
import {
  isRetiredManagedHandoffLeasePayload,
  parseManagedHandoffLeasePayload,
  type HandoffProcessIdentity,
  type ManagedHandoffLeaseAction,
} from "./update-managed-service-handoff-schema.js";
import { createManagedHandoffScopeReader } from "./update-managed-service-handoff-scope.js";
import { hasManagedHandoffSchemaObject } from "./update-managed-service-handoff-source-inspection.js";

// Identity is earned by this process's original acquisition, not by decoding a
// row or copying a grant. Survives the executor pinning/reopening the same DB.
const originalUpdateAdmissions = new WeakMap<
  ManagedHandoffLease,
  ManagedHandoffOriginalAdmission
>();

export type { BorrowedLegacyHandoffParent } from "./update-managed-service-handoff-legacy-parent.js";
export type {
  LeaseAcquisition,
  ManagedHandoffLease,
  ManagedHandoffLeaseStoreOptions,
  ManagedHandoffParent,
} from "./update-managed-service-handoff-lease-types.js";

export function resolveManagedUpdateLeaseDatabasePath(): string {
  return path.join(resolvePreferredOpenClawTmpDir(), "managed-update-handoffs.sqlite");
}

/** One lease implementation, preloaded normally and sealed before package replacement. */
export function createManagedHandoffLeaseStore(
  options: ManagedHandoffLeaseStoreOptions = {
    databasePath: resolveManagedUpdateLeaseDatabasePath(),
    serviceManagerEnv: resolveServiceManagerEnv(),
  },
  logger?: SqliteTransactionOptions["logger"],
) {
  const { databasePath, serviceManagerEnv } = options;
  const bootIdentity = createManagedHandoffBootIdentityReader(serviceManagerEnv);
  const {
    isPidAlive,
    readProcessStartIdentity,
    processIdentity,
    processState,
    inspectProcessIdentity,
    isProcessIdentityCurrent,
    validateDarwinAncestorProcesses,
    acceptSelfIdentity,
  } = createManagedHandoffProcessIdentityReader({
    env: serviceManagerEnv,
    onWarning:
      options.onProcessIdentityWarning ?? ((pid, message) => logger?.warn(message, { pid })),
  });

  const { control, properties, nativeScope, isInNativeScope, nativeClosed } =
    createManagedHandoffScopeReader(serviceManagerEnv);
  const withDatabase = createManagedHandoffLeaseDatabase(
    databasePath,
    options.existingIdentity,
    options.initialStoreAdmission,
  );
  const {
    row,
    handle,
    deleteRow,
    updateRow,
    read,
    readLegacyParent,
    currentLegacyParent,
    sameRow,
  } = createManagedHandoffLeaseRows(options, withDatabase, {
    isProcessIdentityCurrent,
    validateDarwinAncestorProcesses,
  });

  function transact<T>(db: HandoffDatabase, operation: () => T): T {
    return withDatabase.transact(db, operation, { logger });
  }
  function hasUnsettledChildren(
    lease: ManagedHandoffParent,
    connection?: HandoffDatabase,
  ): boolean {
    if (lease.version === 3 || lease.version === 4) {
      return true;
    }
    const prefix = `${lease.key}/.openclaw-update-child-`;
    const inspect = (db: HandoffDatabase) => {
      const children = executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .selectFrom("managed_update_handoffs")
          .select(["install_root", "owner", "payload_json", "updated_at"])
          .where("install_root", ">=", prefix)
          .where("install_root", "<", prefix + "\uffff"),
      ).rows;
      return children.some((entry) => {
        const child = handle(entry.install_root, entry);
        return (
          child.version === 3 ||
          child.version === 4 ||
          processState(child.helper) !== "dead" ||
          processState(child.executor) !== "dead" ||
          (process.platform !== "win32" && isChildProcessTreeAlive(child.executor))
        );
      });
    };
    return connection ? inspect(connection) : withDatabase(false, inspect);
  }
  function reclaimable(lease: ManagedHandoffLease, db?: HandoffDatabase) {
    // No process/boot liveness observation is a join receipt.
    if (lease.version === 3 || lease.version === 4 || hasOriginalUpdateExecutorCustody(lease)) {
      return false;
    }
    const action = lease.action;
    if (action.kind === "triage" && action.lifetime.kind === "foreground") {
      const boot = bootIdentity();
      if (
        boot.platform === action.lifetime.boot.platform &&
        boot.identity !== action.lifetime.boot.identity
      ) {
        return true;
      }
      if (!["reserved", "closed"].includes(action.phase)) {
        return false;
      }
    }
    if (processState(lease.helper) !== "dead" || processState(lease.executor) !== "dead") {
      return false;
    }
    return (
      !hasUnsettledChildren(lease, db) &&
      (action.kind !== "triage" ||
        action.lifetime.kind !== "native" ||
        nativeClosed(action.lifetime))
    );
  }
  function admit(
    root: string,
    owner: string,
    payload: string,
    source?: ManagedHandoffLease,
    legacyParent?: BorrowedLegacyHandoffParent,
    originalParent?: ManagedHandoffParent,
    admissionDatabase?: HandoffDatabase,
  ): LeaseAcquisition {
    const run = (db: HandoffDatabase): LeaseAcquisition => {
      // Probe liveness before taking the write lock; commit only if both observations still match.
      const observed = row(db, root);
      const destination = admissionLease(root, observed, handle, processState);
      const canReplace =
        !destination || (destination.owner !== owner && reclaimable(destination, db));
      const reclaimOriginalPair = observeManagedHandoffOriginalReclamation(
        canReplace ? (destination ?? undefined) : undefined,
        db,
        { handle, deleteRow, reclaimable, hasUnsettledChildren },
      );
      return transact(db, () => {
        if (originalParent && !mutationCurrent(originalParent, db)) {
          return { kind: "busy", owner: originalParent.owner };
        }
        if (destination && !originalAllowsMutation(destination, db)) {
          return { kind: "busy", owner: destination.owner };
        }
        if (
          source &&
          !sameRow(
            { owner: source.owner, payload_json: source.payload, updated_at: source.updatedAt },
            row(db, source.key),
          )
        ) {
          throw new Error("managed triage source changed during admission");
        }
        if (source && (!mutationCurrent(source, db) || hasUnsettledChildren(source, db))) {
          return { kind: "busy", owner: source.owner };
        }
        const childMarker = root.indexOf("/.openclaw-update-child-");
        if (childMarker >= 0) {
          const parentKey = root.slice(0, childMarker);
          const parent = row(db, parentKey);
          if (legacyParent) {
            if (legacyParent.key !== parentKey || !currentLegacyParent(legacyParent, db)) {
              throw new Error("Borrowed legacy update parent changed during child admission");
            }
            if (
              root.lastIndexOf("/.openclaw-update-child-") === childMarker &&
              hasUnsettledChildren(legacyParent, db)
            ) {
              return { kind: "busy", owner: legacyParent.owner };
            }
          } else if (
            !parent ||
            !mutationCurrent(handle(parentKey, parent), db) ||
            handle(parentKey, parent).version === 3
          ) {
            return { kind: "busy", owner: parent?.owner ?? owner };
          }
        } else if (legacyParent) {
          throw new Error("Borrowed legacy update authority admits only child rows");
        }
        const latest = row(db, root);
        if (!sameRow(observed, latest)) {
          if (latest) {
            return { kind: "busy", owner: handle(root, latest).owner };
          }
          throw new Error("managed handoff lease changed during admission");
        }
        const previous = destination ?? readBorrowedLegacyHandoffParent(root, observed);
        if (!canReplace || (previous && hasUnsettledChildren(previous, db))) {
          return { kind: "busy", owner: previous?.owner ?? owner };
        }
        if (!reclaimOriginalPair()) {
          return { kind: "busy", owner: destination?.owner ?? owner };
        }
        if (observed) {
          deleteRow(db, root, observed);
        }
        const updatedAt = Math.max(Date.now(), (source?.updatedAt ?? 0) + 1);
        if (source) {
          if (
            !updateRow(db, source, {
              install_root: root,
              payload_json: payload,
              updated_at: updatedAt,
            })
          ) {
            throw new Error("managed triage source changed during transfer");
          }
        } else {
          executeSqliteQuerySync(
            db,
            leaseQueries(db).insertInto("managed_update_handoffs").values({
              install_root: root,
              owner,
              payload_json: payload,
              updated_at: updatedAt,
            }),
          );
        }
        return {
          kind: "acquired",
          lease: handle(root, { owner, payload_json: payload, updated_at: updatedAt }),
        };
      });
    };
    return admissionDatabase ? run(admissionDatabase) : withDatabase(true, run);
  }
  const acquire = createManagedHandoffOriginalAcquisition({
    options,
    transact,
    acquirePinnedOriginal: (pinnedOptions, root, owner, action) =>
      createManagedHandoffLeaseStore(pinnedOptions, logger).acquire(root, owner, action),
    withDatabase,
    processIdentity,
    read,
    admit,
    originalUpdateAdmissions,
  });
  const { storedCurrent, originalAllowsMutation, childAliases, mutationCurrent, current } =
    createManagedHandoffMutationReader({ withDatabase, row, handle, sameRow, currentLegacyParent });
  const cancelUpdate = createManagedHandoffCancellation({
    existingIdentity: options.existingIdentity,
    originalUpdateAdmissions,
    withDatabase,
    transact,
    mutationCurrent,
    storedCurrent,
    childAliases,
    canRelease,
    handle,
    updateRow,
    deleteRow,
    processState,
  });
  function owns(lease: ManagedHandoffLease, role: "helper" | "executor" = "helper") {
    return (
      current(lease) &&
      !(
        lease.action.kind === "triage" &&
        ["closing", "closed", "uncertain"].includes(lease.action.phase)
      ) &&
      lease[role].pid === process.pid &&
      isProcessIdentityCurrent(lease.helper) &&
      acceptSelfIdentity(lease[role])
    );
  }
  function acceptParentBoundExecutor(lease: ManagedHandoffLease) {
    return (
      current(lease) &&
      lease.version === 2 &&
      lease.action.kind === "update" &&
      lease.helper.pid === process.ppid &&
      lease.executor.pid === process.pid &&
      isProcessIdentityCurrent(lease.helper) &&
      acceptSelfIdentity(lease.executor, true)
    );
  }
  function cas(
    lease: ManagedHandoffLease,
    action: ManagedHandoffLeaseAction,
    executor?: HandoffProcessIdentity,
  ) {
    // Ordinary bind/retarget/triage transitions cannot erase native custody.
    if (
      lease.version === 3 ||
      lease.version === 4 ||
      hasOriginalUpdateExecutorCustody(lease, action)
    ) {
      return null;
    }
    const payload = JSON.stringify({
      ...parseManagedHandoffLeasePayload(lease.payload),
      action,
      ...(executor ? { executor, helper: lease.helper } : {}),
    });
    if (!parseManagedHandoffLeasePayload(payload)) {
      return null;
    }
    return withDatabase(true, (db) =>
      transact(db, () => {
        if (!mutationCurrent(lease, db) || hasUnsettledChildren(lease, db)) {
          return null;
        }
        const updatedAt = Math.max(Date.now(), lease.updatedAt + 1);
        return updateRow(db, lease, { payload_json: payload, updated_at: updatedAt })
          ? handle(lease.key, { owner: lease.owner, payload_json: payload, updated_at: updatedAt })
          : null;
      }),
    );
  }
  function bind(
    lease: ManagedHandoffLease,
    pid: number,
    action = lease.action,
    argv?: readonly string[],
  ) {
    if (!owns(lease)) {
      return null;
    }
    const previous = lease.action;
    if (previous.kind === "triage") {
      if (
        previous.phase !== "reserved" ||
        action.kind !== "triage" ||
        action.phase !== "reserved" ||
        lease.executor.pid !== lease.helper.pid
      ) {
        return null;
      }
      const lifetime =
        previous.lifetime.kind === "native" &&
        action.lifetime.kind === "native" &&
        previous.lifetime.placement.kind === "pending"
          ? { ...previous.lifetime, placement: action.lifetime.placement }
          : previous.lifetime;
      if (JSON.stringify(lifetime) !== JSON.stringify(action.lifetime)) {
        return null;
      }
    } else if (action.kind !== "update") {
      return null;
    }
    return cas(lease, action, processIdentity(pid, argv));
  }
  const {
    bindUpdateChildren,
    bindOriginalUpdateExecutor,
    returnOriginalUpdateExecutor,
    selectOriginalUpdateRetainedRoot,
    releaseOriginalUpdate,
  } = createManagedHandoffOriginalOwner({
    existingIdentity: options.existingIdentity,
    originalUpdateAdmissions,
    deleteRow,
    childAliases,
    admitRetained: (root, owner, payload, db) =>
      admit(root, owner, payload, undefined, undefined, undefined, db),
    withDatabase,
    transact,
    mutationCurrent,
    hasUnsettledChildren,
    processIdentity,
    processState,
    owns,
    row,
    sameRow,
    handle,
    updateRow,
  });
  function retarget(
    lease: ManagedHandoffLease,
    root: string,
    action: ManagedHandoffLeaseAction,
  ): LeaseAcquisition | null {
    if (
      lease.version !== 2 ||
      (lease.action.kind === "update" &&
        lease.action.mutationProtocol === "original-cancellation-v1") ||
      hasUnsettledChildren(lease) ||
      !owns(lease, "executor") ||
      lease.helper.pid !== process.pid ||
      lease.action.kind !== "update" ||
      action.kind !== "triage" ||
      action.phase !== "reserved" ||
      action.lifetime.kind !== "native" ||
      action.lifetime.placement.kind !== "pending"
    ) {
      return null;
    }
    const payload = JSON.stringify({
      version: 2,
      executor: lease.helper,
      helper: lease.helper,
      action,
      ...(lease.mutationOriginal ? { mutationOriginal: lease.mutationOriginal } : {}),
    });
    if (
      !text.safeParse(root).success ||
      !parseManagedHandoffLeasePayload(payload) ||
      fs.realpathSync(root) !== root
    ) {
      throw new Error("managed triage destination is not canonical");
    }
    if (root === lease.key) {
      const next = cas(lease, action, lease.helper);
      return next ? { kind: "acquired", lease: next } : null;
    }
    return admit(root, lease.owner, payload, lease);
  }
  function activate(lease: ManagedHandoffLease) {
    if (
      !owns(lease) ||
      processState(lease.executor) !== "live" ||
      lease.executor.pid === lease.helper.pid ||
      lease.action.kind !== "triage" ||
      lease.action.phase !== "reserved"
    ) {
      return null;
    }
    return cas(lease, { ...lease.action, phase: "running" });
  }
  function readGeneration(lease: ManagedHandoffLease) {
    const result = read(lease.key);
    if (result.kind !== "current") {
      return null;
    }
    const active = result.lease;
    return lease.version === 2 &&
      active.version === 2 &&
      lease.action.kind === "triage" &&
      active.action.kind === "triage" &&
      lease.owner === active.owner &&
      JSON.stringify(lease.helper) === JSON.stringify(active.helper) &&
      JSON.stringify(lease.executor) === JSON.stringify(active.executor) &&
      JSON.stringify(lease.action.lifetime) === JSON.stringify(active.action.lifetime)
      ? { ...active, action: active.action }
      : null;
  }
  function settle(lease: ManagedHandoffLease, phase: "closing" | "closed" | "uncertain") {
    const active = readGeneration(lease);
    if (!active) {
      return null;
    }
    const actor =
      active.helper.pid === process.pid && phase !== "closed" ? active.helper : active.executor;
    if (actor.pid !== process.pid || processState(actor) !== "live") {
      return null;
    }
    if (phase === "closed") {
      if (!["running", "closing"].includes(active.action.phase)) {
        return null;
      }
    } else if (
      active.action.phase === "uncertain" ||
      (phase === "closing" && ["closing", "closed"].includes(active.action.phase))
    ) {
      return active;
    }
    return cas(active, { ...active.action, phase });
  }
  function canRelease(lease: ManagedHandoffLease) {
    if (
      lease.version === 4 ||
      hasOriginalUpdateExecutorCustody(lease) ||
      !withDatabase(false, (db) => storedCurrent(lease, db)) ||
      hasUnsettledChildren(lease) ||
      (lease.key.includes("/.openclaw-update-child-") &&
        lease.executor.pid !== lease.helper.pid &&
        process.platform !== "win32" &&
        isChildProcessTreeAlive(lease.executor))
    ) {
      return false;
    }
    const localHelper = lease.helper.pid === process.pid && processState(lease.helper) === "live";
    const action = lease.action;
    const executorClosed =
      lease.executor.pid === process.pid || processState(lease.executor) === "dead";
    return localHelper
      ? action.kind === "update"
        ? executorClosed
        : action.lifetime.kind === "foreground"
          ? ["reserved", "closed"].includes(action.phase) && executorClosed
          : nativeClosed(action.lifetime)
      : reclaimable(lease);
  }
  function releaseAll(leases: ManagedHandoffLease[]) {
    if (
      !leases.length ||
      new Set(leases.map((lease) => lease.key)).size !== leases.length ||
      leases.some((lease) => !canRelease(lease))
    ) {
      return false;
    }
    return withDatabase(true, (db) =>
      transact(db, () => {
        if (
          leases.some(
            (lease) =>
              hasUnsettledChildren(lease, db) ||
              (lease.version === 2 &&
                lease.action.kind === "update" &&
                lease.action.mutationProtocol === "original-cancellation-v1" &&
                [...childAliases(lease.key, db), ...readOriginalUpdateDependents(lease, db)].some(
                  (key) => !leases.some((paired) => paired.key === key),
                )) ||
              !sameRow(row(db, lease.key), {
                owner: lease.owner,
                payload_json: lease.payload,
                updated_at: lease.updatedAt,
              }),
          )
        ) {
          return false;
        }
        for (const lease of leases) {
          if (
            !deleteRow(db, lease.key, {
              owner: lease.owner,
              payload_json: lease.payload,
              updated_at: lease.updatedAt,
            })
          ) {
            if (leases.length === 1) {
              return false;
            }
            throw new Error("Update executor release changed.");
          }
        }
        return true;
      }),
    );
  }

  function readRetainedSources(): ManagedHandoffLease[] {
    try {
      fs.lstatSync(databasePath);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
    return withDatabase(false, (db) => {
      // Only ordinary inspection may accept an uninitialized store.
      if (!options.existingIdentity && !hasManagedHandoffSchemaObject(db)) {
        return [];
      }
      return executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .selectFrom("managed_update_handoffs")
          .select(["install_root", "owner", "payload_json", "updated_at"]),
      ).rows.flatMap((entry) =>
        // A retired record decodes exactly, so unlike unreadable data it proves
        // the row predates native custody and cannot borrow any source. A record
        // this build cannot decode may still name a source it holds, so it is
        // never discarded here: releasing that source is the hazard this refusal
        // exists for. Store-level damage recovers in the database owner instead.
        isRetiredManagedHandoffLeasePayload(entry.payload_json)
          ? []
          : [handle(entry.install_root, entry)],
      );
    });
  }

  function assertSourceUnborrowed(resource: string) {
    assertNoRetainedSourceBorrower(resource, readRetainedSources());
  }
  function stopNative(lease: ManagedHandoffLease, ownPlacement = false) {
    const life = lease.action.kind === "triage" && lease.action.lifetime;
    if (
      !life ||
      life.kind !== "native" ||
      (life.placement.kind !== "attached" && !ownPlacement) ||
      (!ownPlacement && !current(lease))
    ) {
      return false;
    }
    const scope = nativeScope(life);
    if (
      ownPlacement &&
      (![lease.helper.pid, lease.executor.pid].includes(process.pid) ||
        processState(lease.helper.pid === process.pid ? lease.helper : lease.executor) !== "live" ||
        !isInNativeScope(life, scope))
    ) {
      return false;
    }
    if (nativeClosed(life, scope)) {
      return true;
    }
    if (
      !scope ||
      scope.Id !== life.scope ||
      (life.placement.kind === "attached" && scope.InvocationID !== life.placement.invocation) ||
      (!ownPlacement && !current(lease))
    ) {
      return false;
    }
    const result = control(
      "systemctl",
      ["--user", ...(ownPlacement ? ["--no-block"] : []), "stop", life.scope],
      30000,
    );
    return !result.error && result.status === 0 && (ownPlacement || nativeClosed(life));
  }
  return {
    retainReadConnection: withDatabase.retainReadConnection,
    transact,
    read,
    readLegacyParent,
    acquire,
    bind,
    bindUpdateChildren,
    bindOriginalUpdateExecutor,
    returnOriginalUpdateExecutor,
    selectOriginalUpdateRetainedRoot,
    releaseOriginalUpdate,
    cancelUpdate,
    releaseAll,
    retarget,
    activate,
    owns,
    hasUnsettledChildren,
    acceptParentBoundExecutor,
    current,
    readGeneration,
    settle,
    release: (lease: ManagedHandoffLease) => releaseAll([lease]),
    assertSourceUnborrowed,
    stopNative,
    isInNativeScope,
    processIdentity,
    inspectProcessIdentity,
    isProcessIdentityCurrent,
    readProcessStartIdentity,
    isPidAlive,
    bootIdentity,
    properties,
    validFailure: (value: unknown) => triageFailureSchema.safeParse(value).success,
  };
}

export { triageFailureSchema } from "./update-managed-service-handoff-rows.js";
