import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import type { SqliteTransactionOptions } from "./sqlite-transaction.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import { createManagedHandoffBootIdentityReader } from "./update-managed-service-handoff-boot.js";
import { createManagedHandoffCancellation } from "./update-managed-service-handoff-cancellation.js";
import {
  createManagedHandoffChildReader,
  managedCommandAllowsBinding,
  managedCommandCustody,
  managedCommandUnsettled,
} from "./update-managed-service-handoff-children.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
  readManagedHandoffRepairMetadata,
} from "./update-managed-service-handoff-database.js";
import type {
  BorrowedLegacyHandoffParent,
  LeaseAcquisition,
  ManagedHandoffLease,
  ManagedHandoffLeaseStoreOptions,
  ManagedHandoffParent,
  ManagedHandoffLeaseTransition,
} from "./update-managed-service-handoff-lease-types.js";
import { readBorrowedLegacyHandoffParent } from "./update-managed-service-handoff-legacy-parent.js";
import { createManagedHandoffMutationReader } from "./update-managed-service-handoff-mutation.js";
import { createManagedHandoffOriginalAcquisition } from "./update-managed-service-handoff-original-acquisition.js";
import {
  hasOriginalUpdateExecutorCustody,
  readOriginalUpdateDependents,
  type ManagedHandoffOriginalAdmission,
} from "./update-managed-service-handoff-original-owner.js";
import { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import {
  observeManagedHandoffReclamation,
  prepareManagedHandoffRepair,
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
  type ManagedHandoffLeaseAction,
} from "./update-managed-service-handoff-schema.js";
import { createManagedHandoffScopeReader } from "./update-managed-service-handoff-scope.js";

// Identity is earned by this process's original acquisition, not by decoding a
// row or copying a grant. Survives the executor pinning/reopening the same DB.
const originalUpdateAdmissions = new WeakMap<
  ManagedHandoffLease,
  ManagedHandoffOriginalAdmission
>();

export type {
  BorrowedLegacyHandoffParent,
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
  const withDatabase = createManagedHandoffLeaseDatabase(databasePath, options.existingIdentity);
  const {
    row,
    handle,
    descendants,
    deleteRow,
    updateRow,
    read,
    readLegacyParent,
    readRetainedSources,
    currentLegacyParent,
    sameRow,
  } = createManagedHandoffLeaseRows(options, withDatabase, {
    isProcessIdentityCurrent,
    validateDarwinAncestorProcesses,
  });

  function transact<T>(db: HandoffDatabase, operation: () => T): T {
    return withDatabase.transact(db, operation, { logger });
  }
  const { hasUnsettledChildren, readCommandChildren } = createManagedHandoffChildReader({
    withDatabase,
    handle,
    descendants,
    processState,
  });
  function reclaimable(lease: ManagedHandoffLease, db?: HandoffDatabase) {
    // No process/boot liveness observation is a join receipt.
    if (lease.version === 3 || lease.version === 4 || hasOriginalUpdateExecutorCustody(lease)) {
      return false;
    }
    const action = lease.action;
    if (managedCommandCustody(lease)) {
      return !managedCommandUnsettled(lease) && !hasUnsettledChildren(lease, db);
    }
    if (action.kind === "triage" && action.lifetime.kind === "foreground") {
      const boot = bootIdentity();
      if (
        boot.platform === action.lifetime.boot.platform &&
        boot.identity !== action.lifetime.boot.identity
      ) {
        const repair = (connection: HandoffDatabase) =>
          readManagedHandoffRepairMetadata(connection, lease, (operation) =>
            transact(connection, operation),
          );
        return action.phase === "closed" || !(db ? repair(db) : withDatabase(true, repair));
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
  ): LeaseAcquisition {
    const custody = managedCommandCustody(parseManagedHandoffLeasePayload(payload));
    if (custody && (custody !== "reserved" || !root.includes("/.openclaw-update-child-"))) {
      throw new Error("Managed command custody requires a child reservation");
    }
    const run = (db: HandoffDatabase): LeaseAcquisition => {
      // Probe liveness before taking the write lock; commit only if both observations still match.
      const observed = row(db, root);
      const destination = admissionLease(root, observed, handle, processState);
      const canReplace =
        !destination || (destination.owner !== owner && reclaimable(destination, db));
      const reclaim = canReplace
        ? observeManagedHandoffReclamation(root, destination ?? undefined, db, {
            handle,
            deleteRow,
            reclaimable,
            hasUnsettledChildren,
            readCommandChildren,
            processState,
          })
        : undefined;
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
            parent
              ? !(custody && isRetiredManagedHandoffLeasePayload(parent.payload_json)) &&
                (!mutationCurrent(handle(parentKey, parent), db) ||
                  handle(parentKey, parent).version === 3)
              : custody !== "reserved"
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
        if (!canReplace || hasUnsettledChildren(previous ?? root, db)) {
          return { kind: "busy", owner: previous?.owner ?? owner };
        }
        if (!reclaim?.()) {
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
    return withDatabase(true, run);
  }
  const acquire = createManagedHandoffOriginalAcquisition({
    options,
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
    row,
    handle,
    descendants,
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
  const cas: ManagedHandoffLeaseTransition = (lease, action, executor, recovery) => {
    // Ordinary bind/retarget/triage transitions cannot erase native custody.
    if (
      lease.version === 3 ||
      lease.version === 4 ||
      hasOriginalUpdateExecutorCustody(lease, action) ||
      !managedCommandAllowsBinding(lease, action, executor)
    ) {
      return null;
    }
    const payload = JSON.stringify({
      ...parseManagedHandoffLeasePayload(lease.payload),
      action,
      ...(executor ? { executor, helper: lease.helper } : {}),
    });
    const decoded = parseManagedHandoffLeasePayload(payload);
    if (!decoded) {
      return null;
    }
    return withDatabase(true, (db) =>
      transact(db, () => {
        if (!mutationCurrent(lease, db) || hasUnsettledChildren(lease, db)) {
          return null;
        }
        const updatedAt = Math.max(Date.now(), lease.updatedAt + 1);
        const next = { ...lease, ...decoded, payload, updatedAt };
        return updateRow(db, lease, {
          payload_json: payload,
          updated_at: updatedAt,
          ...(recovery ? { recovery_json: recovery(next) } : {}),
        })
          ? next
          : null;
      }),
    );
  };

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
  // Paired original-root/occupied-slot child rows must become bound atomically.
  // A parent dying between separate binds must not expose either installation.
  function bindUpdateChildren(
    leases: ManagedHandoffLease[],
    pid: number,
    argv?: readonly string[],
  ) {
    if (
      !leases.length ||
      new Set(leases.map((lease) => lease.key)).size !== leases.length ||
      leases.some(
        (lease) =>
          lease.version !== 2 ||
          lease.action.kind !== "update" ||
          managedCommandCustody(lease) === "bound" ||
          !lease.key.includes("/.openclaw-update-child-") ||
          !owns(lease) ||
          !isDeepStrictEqual(lease.helper, lease.executor),
      )
    ) {
      return null;
    }
    const custody = managedCommandCustody(leases[0]!);
    if (
      leases.some((lease) => managedCommandCustody(lease) !== custody) ||
      (custody && pid === process.pid)
    ) {
      return null;
    }
    const executor = processIdentity(pid, argv);
    return withDatabase(true, (db) =>
      transact(db, () => {
        if (
          leases.some((lease) => !mutationCurrent(lease, db) || hasUnsettledChildren(lease, db))
        ) {
          return null;
        }
        return leases.map((lease) => {
          const payload = JSON.stringify({
            version: 2,
            helper: lease.helper,
            executor,
            action: custody ? { ...lease.action, custody: "bound" } : lease.action,
          });
          const updatedAt = Math.max(Date.now(), lease.updatedAt + 1);
          if (!updateRow(db, lease, { payload_json: payload, updated_at: updatedAt })) {
            throw new Error("Candidate process binding changed.");
          }
          return handle(lease.key, {
            owner: lease.owner,
            payload_json: payload,
            updated_at: updatedAt,
          });
        });
      }),
    );
  }
  function retarget(
    lease: ManagedHandoffLease,
    root: string,
    action: ManagedHandoffLeaseAction,
  ): LeaseAcquisition | null {
    if (
      lease.version !== 2 ||
      managedCommandCustody(lease) ||
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
  function canRelease(lease: ManagedHandoffLease, settledReservation = false) {
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
    if (managedCommandCustody(lease)) {
      return managedCommandCustody(lease) === "reserved"
        ? localHelper && settledReservation
        : !managedCommandUnsettled(lease);
    }
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
  function releaseAll(leases: ManagedHandoffLease[], settledReservation = false) {
    if (
      !leases.length ||
      new Set(leases.map((lease) => lease.key)).size !== leases.length ||
      leases.some((lease) => !canRelease(lease, settledReservation))
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
                (lease.action.mutationProtocol === "original-cancellation-v1" ||
                  managedCommandCustody(lease) === "bound") &&
                [...childAliases(lease.key, db), ...readOriginalUpdateDependents(lease, db)].some(
                  (key) => !leases.some((paired) => paired.key === key),
                )) ||
              !storedCurrent(lease, db),
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
  const store = {
    retainReadConnection: withDatabase.retainReadConnection,
    transact,
    read,
    readLegacyParent,
    acquire,
    bind,
    bindUpdateChildren,
    cancelUpdate,
    releaseAll: (leases: ManagedHandoffLease[]) => releaseAll(leases),
    retarget,
    activate,
    owns,
    hasUnsettledChildren,
    readCommandChildren,
    acceptParentBoundExecutor,
    current,
    readGeneration,
    settle,
    release: (lease: ManagedHandoffLease) => releaseAll([lease]),
    releaseCommandReservation: (lease: ManagedHandoffLease) =>
      managedCommandCustody(lease) === "reserved" && releaseAll([lease], true),
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
  const prepareRepair = prepareManagedHandoffRepair.bind(null, store, {
    rows: { handle, updateRow },
    withDatabase,
    processState,
    cas,
  });
  return Object.assign(store, { prepareRepair });
}

export { triageFailureSchema } from "./update-managed-service-handoff-rows.js";
