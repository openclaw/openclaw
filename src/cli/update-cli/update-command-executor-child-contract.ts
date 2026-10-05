import type { ManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
import type {
  ManagedHandoffLease,
  ManagedHandoffParent,
} from "../../infra/update-managed-service-handoff-lease.js";
/** Private correlation sent only to the spawned candidate's stdin. The receiver
 * independently reads both live owners and checks its own PID/start identity. */
export type UpdateCommandChildGrant = {
  runId: string;
  root: string;
  databasePath: string;
  parent: ManagedHandoffParent;
  /** Original owner and its lineage survive a package-generation change. */
  originalParent?: ManagedHandoffParent;
  originalChildKey?: string;
  spawner?: ManagedHandoffLease;
  slot?: {
    parent: ManagedHandoffLease;
    spawner: ManagedHandoffLease;
    /** The live legacy bridge that reserved this slot, retained through descendants. */
    reserver?: ManagedHandoffLease;
    childKey: string;
  };
  retainedParent?: ManagedHandoffLease;
  retainedChildKey?: string;
  childKey: string;
  databaseIdentity?: ManagedUpdateLeaseDatabaseIdentity;
};
export type ChildPurpose = { auxiliaryPreflight?: true };
export type ChildOperation<T> = (
  grant: UpdateCommandChildGrant,
  bindChild: (pid: number, argv?: readonly string[]) => void,
) => Promise<T>;
