import type { ResolvedSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import type {
  SessionEntryMaintenanceInput,
  SessionEntryMaintenancePlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import type { SessionEntryReplacement } from "./session-accessor.types.js";
import type { SessionOwnerAssignment } from "./session-entry-provenance.js";
import type { SessionEntry } from "./types.js";

export type SqliteSessionEntryReplacement = SessionEntryReplacement & {
  previousSessionKeys?: readonly string[];
};

export type SessionEntryReplacementCommit = {
  expectedRows: Map<string, ResolvedSessionEntryRow>;
  labelOwnerKeys: string[];
  includeLabelOwners?: string;
  validationKeys: string[];
  replacements: SqliteSessionEntryReplacement[];
  checkPendingArchiveRecovery?: boolean;
  consumePendingReset?: boolean;
  maintenance?: SessionEntryMaintenanceInput;
  ownerAssignment?: { sessionKey: string; owner: SessionOwnerAssignment };
};

export type SessionEntryReplacementCommitted = {
  pendingArchiveRecovery: boolean;
  previous: Map<string, SessionEntry>;
  current: Map<string, SessionEntry>;
  maintenancePlans: SessionEntryMaintenancePlan[];
  membershipInvalidatedKeys: string[];
};
