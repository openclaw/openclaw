import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import type {
  createManagedHandoffLeaseDatabase,
  LeaseTable,
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
) {
  return lease?.version === 2 && lease.action.kind === "update" ? lease.action.custody : undefined;
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
        action.custody === "bound" &&
        executor !== undefined &&
        executor.pid !== lease.helper.pid
    : action.kind !== "update" || !action.custody;
}

export function createManagedHandoffChildReader(
  deps: Pick<ReturnType<typeof createManagedHandoffLeaseRows>, "handle" | "descendants"> & {
    withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>;
    processState: ReturnType<typeof createManagedHandoffProcessIdentityReader>["processState"];
  },
) {
  function readChildren(
    parent: ManagedHandoffParent | string,
    connection?: HandoffDatabase,
  ): LeaseTable[] {
    const inspect = (db: HandoffDatabase) =>
      deps.descendants(db, typeof parent === "string" ? { key: parent } : parent);
    return connection ? inspect(connection) : deps.withDatabase(false, inspect);
  }
  return {
    hasUnsettledChildren: (parent: ManagedHandoffParent | string, connection?: HandoffDatabase) => {
      if (typeof parent !== "string" && (parent.version === 3 || parent.version === 4)) {
        return true;
      }
      return readChildren(parent, connection).some((entry) => {
        const child = deps.handle(entry.install_root, entry);
        // Legacy unbound reservations name the spawner, not a detached group leader.
        const unbound =
          child.version === 2 &&
          child.action.kind === "update" &&
          !child.action.mutationProtocol &&
          child.executor.pid === child.helper.pid &&
          child.executor.startIdentity === child.helper.startIdentity;
        return managedCommandCustody(child)
          ? managedCommandUnsettled(child)
          : child.version === 3 ||
              child.version === 4 ||
              deps.processState(child.helper) !== "dead" ||
              deps.processState(child.executor) !== "dead" ||
              (!unbound && process.platform !== "win32" && isChildProcessTreeAlive(child.executor));
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
