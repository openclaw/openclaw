import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import { hasErrnoCode } from "./errno.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "./kysely-sync.js";
import type { SqliteTransactionOptions } from "./sqlite-transaction.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import { currentUpdateInitialStoreAdmission } from "./update-initial-store-invocation.js";
import { createManagedHandoffBootIdentityReader } from "./update-managed-service-handoff-boot.js";
import { canCleanupLegacyManagedHandoff } from "./update-managed-service-handoff-cleanup.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
  type LeaseRow,
  type LeaseTable,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import {
  readBorrowedLegacyHandoffParent,
  isBorrowedLegacyHandoffParentCurrent,
  type BorrowedLegacyHandoffParent,
} from "./update-managed-service-handoff-legacy-parent.js";
import { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import { assertNoRetainedSourceBorrower } from "./update-managed-service-handoff-retained-custody.js";
import {
  isRetiredManagedHandoffLeasePayload,
  parseManagedHandoffLeasePayload,
  type HandoffProcessIdentity,
  type ManagedHandoffLeaseAction,
  type ManagedHandoffLeasePayload,
} from "./update-managed-service-handoff-schema.js";
import { createManagedHandoffScopeReader } from "./update-managed-service-handoff-scope.js";
import {
  hasManagedHandoffSchemaObject,
  isManagedHandoffSchemaEmpty,
} from "./update-managed-service-handoff-source-inspection.js";

const text = z.string().min(1).max(4096);
export const triageFailureSchema = z.strictObject({
  kind: z.enum(["update", "gateway-startup"]),
  phase: z.string().max(120),
  error: z.string().max(800),
  installationRoot: text.optional(),
  expectedVersion: z.string().max(100).optional(),
  gateway: z.enum(["verify-running", "preserve"]),
});
export type ManagedHandoffLease = ManagedHandoffLeasePayload & {
  key: string;
  owner: string;
  payload: string;
  updatedAt: number;
};
export type ManagedHandoffParent = ManagedHandoffLease | BorrowedLegacyHandoffParent;
export type { BorrowedLegacyHandoffParent } from "./update-managed-service-handoff-legacy-parent.js";

export function resolveManagedUpdateLeaseDatabasePath(): string {
  return (
    currentUpdateInitialStoreAdmission()?.selection.handoff.databasePath ??
    path.join(resolvePreferredOpenClawTmpDir(), "managed-update-handoffs.sqlite")
  );
}

type LeaseRead =
  | { kind: "absent" | "unreadable" }
  | { kind: "current"; lease: ManagedHandoffLease };
type LeaseAcquisition =
  | { kind: "busy"; owner: string }
  | { kind: "acquired"; lease: ManagedHandoffLease };

/** One lease implementation, preloaded normally and sealed before package replacement. */
export function createManagedHandoffLeaseStore(
  options: {
    databasePath: string;
    serviceManagerEnv: NodeJS.ProcessEnv;
    existingIdentity?: ManagedUpdateLeaseDatabaseIdentity;
    onProcessIdentityWarning?: (pid: number, message: string) => void;
  } = {
    databasePath: resolveManagedUpdateLeaseDatabasePath(),
    serviceManagerEnv: resolveServiceManagerEnv(),
    existingIdentity: currentUpdateInitialStoreAdmission()?.selection.handoff,
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
    acceptSelfIdentity,
  } = createManagedHandoffProcessIdentityReader({
    env: serviceManagerEnv,
    onWarning:
      options.onProcessIdentityWarning ?? ((pid, message) => logger?.warn(message, { pid })),
  });

  const { control, properties, nativeScope, isInNativeScope, nativeClosed } =
    createManagedHandoffScopeReader(serviceManagerEnv);
  const withDatabase = createManagedHandoffLeaseDatabase(databasePath, options.existingIdentity);
  function row(db: HandoffDatabase, root: string) {
    return executeSqliteQueryTakeFirstSync(
      db,
      leaseQueries(db)
        .selectFrom("managed_update_handoffs")
        .select(["owner", "payload_json", "updated_at"])
        .where("install_root", "=", root),
    );
  }
  function handle(root: string, value: LeaseRow): ManagedHandoffLease {
    const payload = parseManagedHandoffLeasePayload(value.payload_json);
    if (!payload || !text.safeParse(value.owner).success) {
      throw new Error(
        "existing managed handoff lease is incompatible; retain diagnostics and run openclaw triage manually",
      );
    }
    return {
      key: root,
      owner: value.owner,
      payload: value.payload_json,
      updatedAt: value.updated_at,
      ...payload,
    };
  }
  function admissionLease(root: string, value: LeaseRow | undefined) {
    // Only admission may retire a positively dead legacy row. Keep its complete
    // observation for the transaction CAS; read/handles require a supported strict schema.
    const legacyDead =
      value &&
      text.safeParse(value.owner).success &&
      Number.isSafeInteger(value.updated_at) &&
      value.updated_at >= 0 &&
      canCleanupLegacyManagedHandoff(value.payload_json, processState);
    return value && !legacyDead ? handle(root, value) : null;
  }
  function deleteRow(db: HandoffDatabase, root: string, value: LeaseRow) {
    return (
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .deleteFrom("managed_update_handoffs")
          .where("install_root", "=", root)
          .where("owner", "=", value.owner)
          .where("payload_json", "=", value.payload_json)
          .where("updated_at", "=", value.updated_at),
      ).numAffectedRows === 1n
    );
  }
  function updateRow(
    db: HandoffDatabase,
    lease: ManagedHandoffLease,
    values: Pick<LeaseTable, "payload_json" | "updated_at"> &
      Partial<Pick<LeaseTable, "install_root">>,
  ) {
    return (
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .updateTable("managed_update_handoffs")
          .set(values)
          .where("install_root", "=", lease.key)
          .where("owner", "=", lease.owner)
          .where("payload_json", "=", lease.payload)
          .where("updated_at", "=", lease.updatedAt),
      ).numAffectedRows === 1n
    );
  }
  function read(root: string): LeaseRead {
    try {
      if (!options.existingIdentity && !fs.existsSync(databasePath)) {
        return { kind: "absent" };
      }
      return withDatabase(false, (db) => {
        if (!options.existingIdentity && isManagedHandoffSchemaEmpty(db)) {
          return { kind: "absent" };
        }
        const value = row(db, root);
        return value ? { kind: "current", lease: handle(root, value) } : { kind: "absent" };
      });
    } catch {
      return { kind: "unreadable" };
    }
  }
  function readLegacyParent(
    root: string,
    executor?: HandoffProcessIdentity,
  ): BorrowedLegacyHandoffParent | null {
    return withDatabase(false, (db) =>
      readBorrowedLegacyHandoffParent(root, row(db, root), executor),
    );
  }
  function currentLegacyParent(parent: BorrowedLegacyHandoffParent, db: HandoffDatabase) {
    return isBorrowedLegacyHandoffParentCurrent(
      parent,
      () => row(db, parent.key),
      isProcessIdentityCurrent,
    );
  }
  const sameRow = (a: LeaseRow | undefined, b: LeaseRow | undefined) =>
    a?.owner === b?.owner && a?.payload_json === b?.payload_json && a?.updated_at === b?.updated_at;
  function transact<T>(db: HandoffDatabase, operation: () => T): T {
    return withDatabase.transact(db, operation, { logger });
  }
  function hasUnsettledChildren(
    lease: ManagedHandoffParent,
    connection?: HandoffDatabase,
  ): boolean {
    if (lease.version === 3) {
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
    if (lease.version === 3) {
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
  ): LeaseAcquisition {
    return withDatabase(true, (db) => {
      // Probe liveness before taking the write lock; commit only if both observations still match.
      const observed = row(db, root);
      const destination = admissionLease(root, observed);
      const canReplace =
        !destination || (destination.owner !== owner && reclaimable(destination, db));
      return transact(db, () => {
        if (
          source &&
          !sameRow(
            { owner: source.owner, payload_json: source.payload, updated_at: source.updatedAt },
            row(db, source.key),
          )
        ) {
          throw new Error("managed triage source changed during admission");
        }
        if (source && hasUnsettledChildren(source, db)) {
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
          } else if (!parent || handle(parentKey, parent).version === 3) {
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
    });
  }
  function acquire(
    root: string,
    owner: string,
    action: ManagedHandoffLeaseAction,
    transition = false,
    legacyParent?: BorrowedLegacyHandoffParent,
  ): LeaseAcquisition {
    const helper = processIdentity();
    const payload = JSON.stringify({ version: 2, executor: helper, helper, action });
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
    return admit(root, owner, payload, undefined, legacyParent);
  }
  function current(lease: ManagedHandoffParent) {
    if (lease.version === 1) {
      return withDatabase(false, (db) => currentLegacyParent(lease, db));
    }
    const result = read(lease.key);
    return result.kind === "current" && isDeepStrictEqual(result.lease, lease);
  }
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
    if (lease.version === 3) {
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
        if (hasUnsettledChildren(lease, db)) {
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
  function retarget(
    lease: ManagedHandoffLease,
    root: string,
    action: ManagedHandoffLeaseAction,
  ): LeaseAcquisition | null {
    if (
      lease.version !== 2 ||
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
  function release(lease: ManagedHandoffLease) {
    if (
      !current(lease) ||
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
    const closed = localHelper
      ? action.kind === "update"
        ? executorClosed
        : action.lifetime.kind === "foreground"
          ? ["reserved", "closed"].includes(action.phase) && executorClosed
          : nativeClosed(action.lifetime)
      : reclaimable(lease);
    if (!closed) {
      return false;
    }
    return withDatabase(true, (db) =>
      transact(
        db,
        () =>
          !hasUnsettledChildren(lease, db) &&
          deleteRow(db, lease.key, {
            owner: lease.owner,
            payload_json: lease.payload,
            updated_at: lease.updatedAt,
          }),
      ),
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
    transact,
    read,
    readLegacyParent,
    acquire,
    bind,
    retarget,
    activate,
    owns,
    hasUnsettledChildren,
    acceptParentBoundExecutor,
    current,
    readGeneration,
    settle,
    release,
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
