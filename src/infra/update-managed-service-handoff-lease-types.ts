import type { admitUpdateInitialStores } from "./update-initial-store-admission.js";
import type { ManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-identity.js";
import type { BorrowedLegacyHandoffParent } from "./update-managed-service-handoff-legacy-parent.js";
import type { ManagedHandoffLeasePayload } from "./update-managed-service-handoff-schema.js";

export type ManagedHandoffLease = ManagedHandoffLeasePayload & {
  key: string;
  owner: string;
  payload: string;
  updatedAt: number;
};

export type ManagedHandoffParent = ManagedHandoffLease | BorrowedLegacyHandoffParent;

export type LeaseAcquisition =
  | { kind: "busy"; owner: string }
  | {
      kind: "acquired";
      lease: ManagedHandoffLease;
      originalDatabaseIdentity?: ManagedUpdateLeaseDatabaseIdentity;
      retainedLease?: ManagedHandoffLease;
    };

export type ManagedHandoffLeaseStoreOptions = {
  databasePath: string;
  serviceManagerEnv: NodeJS.ProcessEnv;
  existingIdentity?: ManagedUpdateLeaseDatabaseIdentity;
  originalUpdateKey?: string;
  originalUpdateRetainedKey?: string;
  initialStoreAdmission?: ReturnType<typeof admitUpdateInitialStores>;
  onProcessIdentityWarning?: (pid: number, message: string) => void;
};
