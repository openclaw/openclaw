import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { isLockOwnerDefinitelyStale } from "../../infra/stale-lock-file.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";

type WorktreeLeaseDatabase = Pick<DB, "worktrees" | "state_leases">;
export const WORKTREE_REMOVING_LEASE_KEY = "__removing__";

export type RunLeaseOwnerChecks = {
  isPidDefinitelyDead?: (pid: number) => boolean;
  getProcessStartTime?: (pid: number) => number | null;
};

function parseLeaseOwnerPayload(payloadJson: string | null): {
  pid?: number;
  starttime?: number;
  exclusive?: true;
} {
  if (!payloadJson) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (!isRecord(parsed)) {
      return {};
    }
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      starttime: typeof parsed.starttime === "number" ? parsed.starttime : undefined,
      ...(parsed.exclusive === true ? { exclusive: true } : {}),
    };
  } catch {
    return {};
  }
}

type ScopeLeaseState = {
  livePids: number[];
  liveCount: number;
  exclusive: boolean;
  removingToken?: string;
};

export function collectLiveRunLeases(
  db: DatabaseSync,
  k: ReturnType<typeof getNodeSqliteKysely<WorktreeLeaseDatabase>>,
  scope: string,
  checks: RunLeaseOwnerChecks,
  reapStale = true,
): ScopeLeaseState {
  const rows = executeSqliteQuerySync(
    db,
    k
      .selectFrom("state_leases")
      .select(["lease_key", "owner", "payload_json"])
      .where("scope", "=", scope),
  ).rows;
  const { staleKeys, ...live } = inspectRunLeases(rows, checks);
  if (reapStale && staleKeys.length > 0) {
    executeSqliteQuerySync(
      db,
      k.deleteFrom("state_leases").where("scope", "=", scope).where("lease_key", "in", staleKeys),
    );
  }
  return live;
}

function inspectRunLeases(
  rows: readonly { lease_key: string; owner: string; payload_json: string | null }[],
  checks: RunLeaseOwnerChecks,
) {
  const livePids: number[] = [];
  const staleKeys: string[] = [];
  let removingToken: string | undefined;
  let liveCount = 0;
  let exclusive = false;
  for (const row of rows) {
    const payload = parseLeaseOwnerPayload(row.payload_json);
    const stale = isLockOwnerDefinitelyStale({
      payload,
      isPidDefinitelyDead: checks.isPidDefinitelyDead,
      getProcessStartTime: checks.getProcessStartTime,
    });
    if (row.lease_key === WORKTREE_REMOVING_LEASE_KEY) {
      // A removal marker whose remover process died before finalize must self-heal,
      // otherwise a still-live worktree stays permanently unadmittable. A live marker
      // carries the owning claim token so a competing remover is rejected.
      if (stale) {
        staleKeys.push(row.lease_key);
      } else {
        removingToken = row.owner;
      }
      continue;
    }
    if (stale) {
      staleKeys.push(row.lease_key);
      continue;
    }
    if (payload.pid !== undefined) {
      livePids.push(payload.pid);
    }
    liveCount += 1;
    exclusive ||= payload.exclusive === true;
  }
  return {
    staleKeys,
    livePids,
    liveCount,
    exclusive,
    ...(removingToken !== undefined ? { removingToken } : {}),
  };
}

const WORKTREE_RUN_LEASE_SCOPE_PREFIX = "worktree-run:";

export function readWorktreeRunLeaseStateInDatabase(db: DatabaseSync) {
  const k = getNodeSqliteKysely<WorktreeLeaseDatabase>(db);
  const rows = executeSqliteQuerySync(
    db,
    k
      .selectFrom("state_leases")
      .select(["scope", "lease_key", "owner", "payload_json"])
      .where("scope", "like", `${WORKTREE_RUN_LEASE_SCOPE_PREFIX}%`),
  ).rows;
  const liveScopes = new Set<string>();
  const staleScopes = new Set<string>();
  for (const row of rows) {
    const state = inspectRunLeases([row], {});
    if (state.livePids.length > 0) {
      liveScopes.add(row.scope);
    }
    if (state.staleKeys.length > 0) {
      staleScopes.add(row.scope);
    }
  }
  return { liveScopes: [...liveScopes], staleScopes: [...staleScopes] };
}

export function reapWorktreeRunLeasesInDatabase(db: DatabaseSync, scopes: string[]): void {
  const k = getNodeSqliteKysely<WorktreeLeaseDatabase>(db);
  for (const scope of scopes) {
    // Recheck current owners under the transaction; the sweep grants no delete authority.
    collectLiveRunLeases(db, k, scope, {});
  }
}

export class WorktreeRemovalContentionError extends Error {
  constructor(
    readonly kind: "busy" | "finalized",
    message: string,
  ) {
    super(message);
    this.name = "WorktreeRemovalContentionError";
  }
}

export function worktreeRunLeaseScope(worktreeId: string): string {
  return `${WORKTREE_RUN_LEASE_SCOPE_PREFIX}${worktreeId}`;
}

/** Removed exact snapshots retain exclusive lifecycle custody during destructive expiry. */
export function assertRegistryMutationCustody(
  db: DatabaseSync,
  k: ReturnType<typeof getNodeSqliteKysely<WorktreeLeaseDatabase>>,
  id: string,
  token?: string,
) {
  const record = executeSqliteQuerySync(
    db,
    k.selectFrom("worktrees").select(["removed_at", "snapshot_ref"]).where("id", "=", id),
  ).rows[0];
  if (
    record?.removed_at == null ||
    !record.snapshot_ref?.startsWith("refs/openclaw/snapshots/exact-")
  ) {
    return;
  }
  const { removingToken } = collectLiveRunLeases(db, k, worktreeRunLeaseScope(id), {});
  if (removingToken !== undefined && removingToken !== token) {
    throw new WorktreeRemovalContentionError(
      "busy",
      "Exact-state snapshot expiration owns this lifecycle",
    );
  }
}
