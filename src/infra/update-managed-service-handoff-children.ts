import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import { findCommandReservationHolders } from "../process/command-reservation-census.js";
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

type ManagedHandoffProcessState = ReturnType<
  typeof createManagedHandoffProcessIdentityReader
>["processState"];

export function managedCommandCustody(
  lease: ManagedHandoffParent | ManagedHandoffLeasePayload | null,
) {
  return lease?.version === 2 && lease.action.kind === "update" ? lease.action.custody : undefined;
}

function reservationAbandoned(
  lease: ManagedHandoffLease,
  processState: ManagedHandoffProcessState,
): boolean {
  if (processState(lease.helper) !== "dead") {
    return false;
  }
  try {
    const reservation = lease.key.slice(lease.key.lastIndexOf("/") + 1);
    return findCommandReservationHolders(reservation).length === 0;
  } catch {
    return false;
  }
}

/**
 * Only group extinction closes a binding. A reservation has no process identity, so
 * it closes when its spawner is dead and no process carries its marker. Reservations
 * from releases without the marker close on spawner death alone: repair must not stay
 * fenced forever by a child that could only have started in the instant before a kill.
 */
export function managedCommandUnsettled(
  lease: ManagedHandoffLease,
  processState: ManagedHandoffProcessState,
): boolean {
  if (process.platform === "win32") {
    return true;
  }
  return managedCommandCustody(lease) === "bound"
    ? isChildProcessTreeAlive(lease.executor)
    : !reservationAbandoned(lease, processState);
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
          ? managedCommandUnsettled(child, deps.processState)
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
