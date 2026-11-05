import "./run-lease.js";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../../state/openclaw-state-db-readonly.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { collectLiveRunLeases, worktreeRunLeaseScope } from "./run-lease-owner.js";

export function hasLiveWorktreeRunLease(env: NodeJS.ProcessEnv, worktreeId: string): boolean {
  return (
    withExistingOpenClawStateDatabaseCurrentReadOnly(
      ({ db }) =>
        collectLiveRunLeases(
          db,
          getNodeSqliteKysely<Pick<DB, "worktrees" | "state_leases">>(db),
          worktreeRunLeaseScope(worktreeId),
          false,
        ).livePids.length > 0,
      { env },
    ) ?? false
  );
}

type WorktreeRunLeaseTesting = {
  drainPendingCleanupsForTest(): Promise<void>;
  resetForTest(): void;
};

type WorktreeRunLeaseTestApi = {
  testing: WorktreeRunLeaseTesting;
};

function getTestApi(): WorktreeRunLeaseTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.worktreeRunLeaseTestApi")
  ] as WorktreeRunLeaseTestApi;
}

export const testing = getTestApi().testing;
