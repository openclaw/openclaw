import { spawnSync } from "node:child_process";
import fs, { type Stats } from "node:fs";
import path from "node:path";
import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "./sqlite-transaction.js";
import { canCleanupLegacyManagedHandoff } from "./update-managed-service-handoff-cleanup.ts";
import { createHandoffProcessIdentity } from "./update-managed-service-handoff-identity-runtime.ts";
import {
  isManagedHandoffText as text,
  isManagedTriageFailure as validFailure,
  parseManagedHandoffPayload as parse,
  type HandoffNativeLifetime,
  type HandoffProcessIdentity,
  type ManagedHandoffLease,
  type ManagedHandoffLeaseAction,
} from "./update-managed-service-handoff-lease-state.ts";

type LeaseRow = { owner: string; payload_json: string; updated_at: number };
type LeaseTable = LeaseRow & { install_root: string };
const leaseQueries = (db: HandoffDatabase) =>
  getNodeSqliteKysely<{ managed_update_handoffs: LeaseTable }>(db);
type LeaseRead =
  | { kind: "absent" | "unreadable" }
  | { kind: "current"; lease: ManagedHandoffLease };
type LeaseAcquisition =
  | { kind: "busy"; owner: string }
  | { kind: "acquired"; lease: ManagedHandoffLease };

/** One lease implementation, preloaded normally and sealed before package replacement. */
export function createManagedHandoffLeaseRuntime(
  options: { databasePath: string; serviceManagerEnv: Record<string, string> },
  logger?: SqliteTransactionOptions["logger"],
) {
  const { databasePath, serviceManagerEnv } = options;
  if (
    !serviceManagerEnv ||
    typeof serviceManagerEnv !== "object" ||
    Array.isArray(serviceManagerEnv) ||
    Object.values(serviceManagerEnv).some((value) => typeof value !== "string") ||
    Buffer.byteLength(JSON.stringify(serviceManagerEnv)) > 32768
  ) {
    throw new Error("managed handoff service control environment is invalid");
  }
  const { isPidAlive, readProcessStartIdentity, processState, processIdentity, bootIdentity } =
    createHandoffProcessIdentity(serviceManagerEnv);
  function properties(stdout: string | Buffer | null | undefined): Record<string, string> {
    return Object.fromEntries(
      String(stdout || "")
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const i = line.indexOf("=");
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
  }
  function nativeScope(life: HandoffNativeLifetime) {
    const result = spawnSync(
      "systemctl",
      [
        "--user",
        "show",
        life.scope,
        "--property=Id,LoadState,ActiveState,InvocationID,ControlGroup",
      ],
      {
        env: serviceManagerEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        killSignal: "SIGKILL",
      },
    );
    const scope = properties(result.stdout);
    return !result.error && (result.status === 0 || scope.LoadState === "not-found") ? scope : null;
  }
  function nativeClosed(life: HandoffNativeLifetime, scope = nativeScope(life)) {
    // systemd retains populated cgroups even after failed/reset-failed. Its
    // cgroup retirement and unit GC require recursive emptiness, unlike ActiveState.
    return Boolean(
      scope &&
      scope.Id === life.scope &&
      (scope.LoadState === "not-found" ||
        (scope.LoadState === "loaded" &&
          ["inactive", "failed"].some((state) => state === scope.ActiveState) &&
          scope.ControlGroup === "" &&
          (life.placement.kind === "pending" || scope.InvocationID === life.placement.invocation))),
    );
  }
  function assertPath(stat: Stats, kind: "directory" | "file") {
    if (
      stat.isSymbolicLink() ||
      !(kind === "directory" ? stat.isDirectory() : stat.isFile()) ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error("managed handoff lease " + kind + " is unsafe");
    }
  }
  function withDatabase<T>(write: boolean, operation: (db: HandoffDatabase) => T): T {
    const dir = path.dirname(databasePath);
    if (write) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(dir);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      ) {
        throw new Error("managed handoff lease directory is unsafe");
      }
      fs.chmodSync(dir, 0o700);
    }
    assertPath(fs.lstatSync(dir), "directory");
    if (!write || fs.existsSync(databasePath)) {
      assertPath(fs.lstatSync(databasePath), "file");
    }
    const db = openNodeSqliteDatabase(databasePath, { readOnly: !write });
    try {
      setSqliteBusyTimeout(db, 5000);
      if (write) {
        executeSqliteQuerySync(
          db,
          leaseQueries(db)
            .schema.createTable("managed_update_handoffs")
            .ifNotExists()
            .addColumn("install_root", "text", (column) => column.notNull().primaryKey())
            .addColumn("owner", "text", (column) => column.notNull())
            .addColumn("payload_json", "text", (column) => column.notNull())
            .addColumn("updated_at", "integer", (column) => column.notNull())
            .modifyEnd(sql`STRICT`),
        );
        fs.chmodSync(databasePath, 0o600);
      }
      return operation(db);
    } finally {
      // Canonical rollback may already close a damaged handle; keep its original error.
      if (db.isOpen) {
        db.close();
      }
    }
  }
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
    const payload = parse(value.payload_json);
    if (!payload || !text(value.owner)) {
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
    // observation for the transaction CAS; read/handles remain strictly v2.
    const legacyDead =
      value &&
      text(value.owner) &&
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
      if (!fs.existsSync(databasePath)) {
        return { kind: "absent" };
      }
      return withDatabase(false, (db) => {
        const value = row(db, root);
        return value ? { kind: "current", lease: handle(root, value) } : { kind: "absent" };
      });
    } catch {
      return { kind: "unreadable" };
    }
  }
  const sameRow = (a: LeaseRow | undefined, b: LeaseRow | undefined) =>
    (!a && !b) ||
    Boolean(
      a &&
      b &&
      a.owner === b.owner &&
      a.payload_json === b.payload_json &&
      a.updated_at === b.updated_at,
    );
  function transact<T>(db: HandoffDatabase, operation: () => T): T {
    return runSqliteImmediateTransactionSync(db, operation, { logger });
  }
  function reclaimable(lease: ManagedHandoffLease) {
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
      action.kind !== "triage" || action.lifetime.kind !== "native" || nativeClosed(action.lifetime)
    );
  }
  function acquire(
    root: string,
    owner: string,
    action: ManagedHandoffLeaseAction,
    transition = false,
  ): LeaseAcquisition {
    const helper = processIdentity();
    const payload = JSON.stringify({ version: 2, executor: helper, helper, action });
    if (!text(root) || !text(owner) || !parse(payload)) {
      throw new Error("managed handoff admission is invalid");
    }
    return withDatabase(true, (db) => {
      const observed = row(db, root);
      const currentLease = admissionLease(root, observed);
      const resuming =
        transition &&
        currentLease?.owner === owner &&
        currentLease.payload === payload &&
        action.kind === "triage" &&
        action.phase === "reserved" &&
        action.lifetime.kind === "native" &&
        action.lifetime.placement.kind === "pending";
      if (transition && !resuming) {
        throw new Error("managed triage transition lost its current lease");
      }
      const canReplace =
        !currentLease || (!transition && currentLease.owner !== owner && reclaimable(currentLease));
      return transact(db, () => {
        const latest = row(db, root);
        if (!sameRow(observed, latest)) {
          // A concurrent owner won admission or advanced its generation; leave it untouched.
          if (!transition && latest) {
            return { kind: "busy", owner: handle(root, latest).owner };
          }
          throw new Error("managed handoff lease changed during admission");
        }
        if (resuming) {
          return { kind: "acquired", lease: currentLease };
        }
        if (!canReplace) {
          return { kind: "busy", owner: currentLease.owner };
        }
        if (observed) {
          deleteRow(db, root, observed);
        }
        const updatedAt = Date.now();
        executeSqliteQuerySync(
          db,
          leaseQueries(db).insertInto("managed_update_handoffs").values({
            install_root: root,
            owner,
            payload_json: payload,
            updated_at: updatedAt,
          }),
        );
        return {
          kind: "acquired",
          lease: handle(root, { owner, payload_json: payload, updated_at: updatedAt }),
        };
      });
    });
  }
  function current(lease: ManagedHandoffLease) {
    const result = read(lease.key);
    return (
      result.kind === "current" &&
      result.lease.owner === lease.owner &&
      result.lease.payload === lease.payload &&
      result.lease.updatedAt === lease.updatedAt
    );
  }
  function owns(lease: ManagedHandoffLease, role: "helper" | "executor" = "helper") {
    return (
      current(lease) &&
      !(
        lease.action.kind === "triage" &&
        ["closing", "closed", "uncertain"].includes(lease.action.phase)
      ) &&
      lease[role].pid === process.pid &&
      processState(lease.helper) === "live" &&
      (role === "helper" || processState(lease.executor) === "live")
    );
  }
  function cas(
    lease: ManagedHandoffLease,
    action: ManagedHandoffLeaseAction,
    executor?: HandoffProcessIdentity,
  ) {
    const payload = JSON.stringify({
      ...parse(lease.payload),
      action,
      ...(executor ? { executor, helper: lease.helper } : {}),
    });
    if (!parse(payload)) {
      return null;
    }
    return withDatabase(true, (db) => {
      const updatedAt = Math.max(Date.now(), lease.updatedAt + 1);
      return updateRow(db, lease, { payload_json: payload, updated_at: updatedAt })
        ? handle(lease.key, { owner: lease.owner, payload_json: payload, updated_at: updatedAt })
        : null;
    });
  }
  function bind(lease: ManagedHandoffLease, pid: number, action = lease.action) {
    if (!owns(lease) || !Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    const executor = processIdentity(pid);
    const previous = lease.action;
    if (
      previous.kind === "triage" &&
      (action.kind !== "triage" ||
        previous.phase !== "reserved" ||
        action.phase !== "reserved" ||
        previous.lifetime.kind !== "native" ||
        action.lifetime.kind !== "native" ||
        previous.lifetime.unit !== action.lifetime.unit ||
        previous.lifetime.scope !== action.lifetime.scope ||
        (previous.lifetime.placement.kind === "attached" &&
          JSON.stringify(previous.lifetime.placement) !==
            JSON.stringify(action.lifetime.placement)))
    ) {
      // Foreground reservation may bind exactly one executor without changing its lifetime.
      if (
        previous.phase !== "reserved" ||
        JSON.stringify(action) !== JSON.stringify(previous) ||
        lease.executor.pid !== lease.helper.pid
      ) {
        return null;
      }
    }
    if (
      previous.kind === "update" &&
      action.kind === "triage" &&
      (action.phase !== "reserved" ||
        action.lifetime.kind !== "native" ||
        action.lifetime.placement.kind !== "pending")
    ) {
      return null;
    }
    return cas(lease, action, executor);
  }
  function retarget(
    lease: ManagedHandoffLease,
    root: string,
    action: ManagedHandoffLeaseAction,
  ): LeaseAcquisition | null {
    if (
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
    if (!text(root) || !parse(payload) || fs.realpathSync(root) !== root) {
      throw new Error("managed triage destination is not canonical");
    }
    if (root === lease.key) {
      const next = bind(lease, process.pid, action);
      return next ? { kind: "acquired", lease: next } : null;
    }
    return withDatabase(true, (db) => {
      // The source key was captured before package exposure; realpath(source) may now
      // name the destination. Probe reclamation outside the synchronous transaction.
      const source = {
        owner: lease.owner,
        payload_json: lease.payload,
        updated_at: lease.updatedAt,
      };
      const observed = row(db, root);
      const destination = admissionLease(root, observed);
      const canReplace =
        !destination || (destination.owner !== lease.owner && reclaimable(destination));
      return transact(db, () => {
        if (!sameRow(source, row(db, lease.key))) {
          throw new Error("managed triage source changed during admission");
        }
        const latest = row(db, root);
        if (!sameRow(observed, latest)) {
          if (latest) {
            return { kind: "busy", owner: handle(root, latest).owner };
          }
          throw new Error("managed triage destination changed during admission");
        }
        if (!canReplace) {
          return { kind: "busy", owner: destination.owner };
        }
        // Both complete rows still match. A failed source CAS rolls back destination
        // reclamation, so source loss can never remove the other installation's owner.
        if (observed) {
          deleteRow(db, root, observed);
        }
        const updatedAt = Math.max(Date.now(), lease.updatedAt + 1);
        if (
          !updateRow(db, lease, {
            install_root: root,
            payload_json: payload,
            updated_at: updatedAt,
          })
        ) {
          throw new Error("managed triage source changed during transfer");
        }
        return {
          kind: "acquired",
          lease: handle(root, { owner: lease.owner, payload_json: payload, updated_at: updatedAt }),
        };
      });
    });
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
  function sameGeneration(
    a: ManagedHandoffLease,
    b: ManagedHandoffLease,
  ): b is ManagedHandoffLease & { action: Extract<ManagedHandoffLeaseAction, { kind: "triage" }> } {
    return (
      a.owner === b.owner &&
      a.key === b.key &&
      JSON.stringify(a.helper) === JSON.stringify(b.helper) &&
      JSON.stringify(a.executor) === JSON.stringify(b.executor) &&
      a.action.kind === "triage" &&
      b.action.kind === "triage" &&
      JSON.stringify(a.action.lifetime) === JSON.stringify(b.action.lifetime)
    );
  }
  function readGeneration(lease: ManagedHandoffLease) {
    const result = read(lease.key);
    return result.kind === "current" && sameGeneration(lease, result.lease) ? result.lease : null;
  }
  function revoke(lease: ManagedHandoffLease, uncertain = false) {
    const currentLease = readGeneration(lease);
    if (!currentLease) {
      return null;
    }
    if (
      ![currentLease.helper.pid, currentLease.executor.pid].includes(process.pid) ||
      processState(
        currentLease.helper.pid === process.pid ? currentLease.helper : currentLease.executor,
      ) !== "live"
    ) {
      return null;
    }
    if (
      currentLease.action.phase === "uncertain" ||
      (!uncertain && ["closing", "closed"].includes(currentLease.action.phase))
    ) {
      return currentLease;
    }
    return cas(currentLease, {
      ...currentLease.action,
      phase: uncertain ? "uncertain" : "closing",
    });
  }
  function complete(lease: ManagedHandoffLease) {
    const currentLease = readGeneration(lease);
    if (
      !currentLease ||
      lease.executor.pid !== process.pid ||
      processState(lease.executor) !== "live"
    ) {
      return null;
    }
    if (!["running", "closing"].includes(currentLease.action.phase)) {
      return null;
    }
    return cas(currentLease, { ...currentLease.action, phase: "closed" });
  }
  function release(lease: ManagedHandoffLease) {
    if (!current(lease)) {
      return false;
    }
    const localHelper = lease.helper.pid === process.pid && processState(lease.helper) === "live";
    let closed = reclaimable(lease);
    if (localHelper) {
      if (lease.action.kind === "update") {
        closed = lease.executor.pid === process.pid || processState(lease.executor) === "dead";
      } else if (lease.action.lifetime.kind === "foreground") {
        closed =
          ["reserved", "closed"].includes(lease.action.phase) &&
          (lease.executor.pid === process.pid || processState(lease.executor) === "dead");
      } else {
        closed = nativeClosed(lease.action.lifetime);
      }
    }
    if (!closed) {
      return false;
    }
    return withDatabase(true, (db) => {
      return deleteRow(db, lease.key, {
        owner: lease.owner,
        payload_json: lease.payload,
        updated_at: lease.updatedAt,
      });
    });
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
    if (
      ownPlacement &&
      (![lease.helper.pid, lease.executor.pid].includes(process.pid) ||
        processState(lease.helper.pid === process.pid ? lease.helper : lease.executor) !== "live" ||
        !fs
          .readFileSync("/proc/self/cgroup", "utf8")
          .trim()
          .endsWith("/" + life.scope))
    ) {
      return false;
    }
    const scope = nativeScope(life);
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
    const result = spawnSync(
      "systemctl",
      ["--user", ...(ownPlacement ? ["--no-block"] : []), "stop", life.scope],
      {
        env: serviceManagerEnv,
        stdio: "ignore",
        timeout: 30000,
        killSignal: "SIGKILL",
      },
    );
    return !result.error && result.status === 0 && (ownPlacement || nativeClosed(life));
  }
  return {
    transact,
    read,
    acquire,
    bind,
    retarget,
    activate,
    owns,
    current,
    readGeneration,
    revoke,
    complete,
    release,
    stopNative,
    processIdentity,
    readProcessStartIdentity,
    isPidAlive,
    bootIdentity,
    properties,
    validFailure,
  };
}
