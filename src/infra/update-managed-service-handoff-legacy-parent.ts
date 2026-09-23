import { isDeepStrictEqual } from "node:util";
import { getSelfAndAncestorPidsSync } from "./restart-stale-pids.js";
import type { LeaseRow } from "./update-managed-service-handoff-database.js";
import {
  parseRetiredManagedHandoffLeasePayload,
  type HandoffProcessIdentity,
} from "./update-managed-service-handoff-schema.js";

/** Read-only authority borrowed while the shipped v1 helper owns its unchanged row. */
export type BorrowedLegacyHandoffParent = Readonly<{
  version: 1;
  key: string;
  owner: string;
  payload: string;
  updatedAt: number;
  helper: HandoffProcessIdentity;
  executor: HandoffProcessIdentity;
  action: { kind: "update" };
}>;

export function readBorrowedLegacyHandoffParent(
  root: string,
  row: LeaseRow | undefined,
  executor?: HandoffProcessIdentity,
): BorrowedLegacyHandoffParent | null {
  const payload = row && parseRetiredManagedHandoffLeasePayload(row.payload_json);
  if (
    !row ||
    !payload ||
    row.owner.length === 0 ||
    row.owner.length > 4096 ||
    !Number.isSafeInteger(row.updated_at) ||
    row.updated_at < 0
  ) {
    return null;
  }
  const identity = { pid: payload.pid, startIdentity: payload.startIdentity };
  return {
    version: 1,
    key: root,
    owner: row.owner,
    payload: row.payload_json,
    updatedAt: row.updated_at,
    helper: identity,
    executor: executor ?? identity,
    action: { kind: "update" },
  };
}

/** The shipped runner may supervise a respawned updater instead of execing it. */
export function isBorrowedLegacyHandoffParentCurrent(
  parent: BorrowedLegacyHandoffParent,
  readRow: () => LeaseRow | undefined,
  isProcessIdentityCurrent: (identity: HandoffProcessIdentity) => boolean,
): boolean {
  const ancestors = [...getSelfAndAncestorPidsSync(undefined, { requireVerifiedParent: true })];
  const executorIndex = ancestors.indexOf(parent.executor.pid);
  return (
    executorIndex > 0 &&
    ancestors.indexOf(parent.helper.pid) >= executorIndex &&
    isProcessIdentityCurrent(parent.helper) &&
    isProcessIdentityCurrent(parent.executor) &&
    isDeepStrictEqual(
      readBorrowedLegacyHandoffParent(parent.key, readRow(), parent.executor),
      parent,
    )
  );
}
