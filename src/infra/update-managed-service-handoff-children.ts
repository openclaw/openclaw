import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import {
  type createManagedHandoffLeaseDatabase,
  type LeaseTable,
  leaseQueries,
} from "./update-managed-service-handoff-database.js";
import type {
  ManagedHandoffLease,
  ManagedHandoffParent,
} from "./update-managed-service-handoff-lease-types.js";
import type { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import type { createManagedHandoffLeaseRows } from "./update-managed-service-handoff-rows.js";
import type {
  HandoffProcessIdentity,
  ManagedHandoffLeaseAction,
  ManagedHandoffLeasePayload,
} from "./update-managed-service-handoff-schema.js";

export function managedCommandCustody(
  lease: ManagedHandoffParent | ManagedHandoffLeasePayload | null,
  key?: string,
) {
  if (
    lease?.version !== 2 ||
    lease.action.kind !== "update" ||
    lease.action.mutationProtocol !== undefined ||
    lease.mutationOriginal !== undefined
  ) {
    return undefined;
  }
  const commandKey = "key" in lease ? lease.key : key;
  if (!commandKey || !/\/\.openclaw-update-child-[a-f0-9-]{36}-command$/.test(commandKey)) {
    return undefined;
  }
  return (
    lease.action.custody ?? (isDeepStrictEqual(lease.helper, lease.executor) ? "reserved" : "bound")
  );
}

/** Tracked command reservations outlive their helper; only group extinction closes a binding. */
export function managedCommandUnsettled(lease: ManagedHandoffLease): boolean {
  return (
    managedCommandCustody(lease) !== "bound" ||
    process.platform === "win32" ||
    isChildProcessTreeAlive(lease.executor)
  );
}

export function managedCommandAllowsBinding(
  lease: ManagedHandoffLease,
  action: ManagedHandoffLeaseAction,
  executor?: HandoffProcessIdentity,
): boolean {
  const custody = managedCommandCustody(lease);
  return custody
    ? custody === "reserved" &&
        action.kind === "update" &&
        action.mutationProtocol === undefined &&
        executor !== undefined &&
        executor.pid !== lease.helper.pid
    : true;
}

function releasedManagedCommandAction(action: ManagedHandoffLease["action"]) {
  if (action.kind !== "update") {
    return action;
  }
  return {
    kind: "update" as const,
    ...("mutationProtocol" in action && action.mutationProtocol
      ? { mutationProtocol: action.mutationProtocol }
      : {}),
  };
}

export function managedCommandBinding(leases: readonly ManagedHandoffLease[], pid: number) {
  const custody = managedCommandCustody(leases[0]!);
  return leases.some((lease) => managedCommandCustody(lease) !== custody) ||
    (custody !== undefined && pid === process.pid)
    ? null
    : { custody };
}

export function serializeManagedCommandBinding(
  lease: ManagedHandoffLease,
  executor: HandoffProcessIdentity,
  custody: ReturnType<typeof managedCommandCustody>,
) {
  return JSON.stringify({
    version: 2,
    helper: lease.helper,
    executor,
    action: custody ? releasedManagedCommandAction(lease.action) : lease.action,
  });
}

export function createManagedHandoffChildReader(deps: {
  withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>;
  handle: ReturnType<typeof createManagedHandoffLeaseRows>["handle"];
  processState: ReturnType<typeof createManagedHandoffProcessIdentityReader>["processState"];
}) {
  function readChildren(
    parent: ManagedHandoffParent | string,
    connection?: HandoffDatabase,
  ): LeaseTable[] {
    const prefix = `${typeof parent === "string" ? parent : parent.key}/.openclaw-update-child-`;
    const inspect = (db: HandoffDatabase) =>
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .selectFrom("managed_update_handoffs")
          .select(["install_root", "owner", "payload_json", "updated_at"])
          .where("install_root", ">=", prefix)
          .where("install_root", "<", prefix + "\uffff"),
      ).rows;
    return connection ? inspect(connection) : deps.withDatabase(false, inspect);
  }
  return {
    hasUnsettledChildren: (parent: ManagedHandoffParent | string, connection?: HandoffDatabase) => {
      if (typeof parent !== "string" && (parent.version === 3 || parent.version === 4)) {
        return true;
      }
      return readChildren(parent, connection).some((entry) => {
        const child = deps.handle(entry.install_root, entry);
        return managedCommandCustody(child)
          ? managedCommandUnsettled(child)
          : child.version === 3 ||
              child.version === 4 ||
              deps.processState(child.helper) !== "dead" ||
              deps.processState(child.executor) !== "dead" ||
              (process.platform !== "win32" && isChildProcessTreeAlive(child.executor));
      });
    },
    readCommandChildren: (roots: readonly string[], connection?: HandoffDatabase) => {
      const inspect = (db: HandoffDatabase) => [
        ...new Map(
          roots
            .flatMap((root) => readChildren(root, db))
            .map((entry) => deps.handle(entry.install_root, entry))
            .filter((lease) => managedCommandCustody(lease))
            .map((lease) => [lease.key, lease]),
        ).values(),
      ];
      return connection ? inspect(connection) : deps.withDatabase(false, inspect);
    },
  };
}
