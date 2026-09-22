import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Updateable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type {
  WorkerEnvironmentCredentials,
  WorkerEnvironmentSshFallbackPorts,
  WorkerEnvironments,
} from "../../state/openclaw-state-db.generated.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import type { WorkerEnvironmentState } from "./state.js";
import {
  getRequiredWorkerEnvironment,
  json,
  listRows,
  queryWorkerEnvironmentStore,
} from "./store-row-codec.js";
import {
  assertCredentialSessionBinding,
  normalizeCredentialHash,
  normalizeExpiry,
  normalizeRpcSetVersion,
  normalizeSessionId,
} from "./store-validation.js";
import type { CredentialInput } from "./store-write-types.js";
type RowUpdate = Updateable<WorkerEnvironments>;
type SshFallbackPortInsert = Insertable<WorkerEnvironmentSshFallbackPorts>;
type CredentialInsert = Insertable<WorkerEnvironmentCredentials>;

function nextOwnerEpoch(ownerEpoch: number): number {
  const next = ownerEpoch + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error("Worker environment owner epoch is exhausted");
  }
  return next;
}
export function nextGlobalOwnerEpoch(db: DatabaseSync): number {
  // Transcript commit identity is (session, epoch, seq), so an ownership
  // generation may never be reused when a session moves between environments.
  const latestEnvironment = executeSqliteQueryTakeFirstSync(
    db,
    queryWorkerEnvironmentStore(db)
      .selectFrom("worker_environments")
      .select(({ fn }) => fn.max<number>("owner_epoch").as("owner_epoch")),
  );
  const latestTranscriptCommit = executeSqliteQueryTakeFirstSync(
    db,
    queryWorkerEnvironmentStore(db)
      .selectFrom("worker_transcript_commit_heads")
      .select(({ fn }) => fn.max<number>("run_epoch").as("run_epoch")),
  );
  return nextOwnerEpoch(
    Math.max(latestEnvironment?.owner_epoch ?? 0, latestTranscriptCommit?.run_epoch ?? 0),
  );
}
export function updateRow(
  db: DatabaseSync,
  id: string,
  state: WorkerEnvironmentState,
  values: RowUpdate,
) {
  const result = executeSqliteQuerySync(
    db,
    queryWorkerEnvironmentStore(db)
      .updateTable("worker_environments")
      .set(values)
      .where("environment_id", "=", id)
      .where("state", "=", state),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Worker environment ${id} changed during update`);
  }
}
export function updateWorkerEnvironmentRecord(
  db: DatabaseSync,
  id: string,
  state: WorkerEnvironmentState,
  values: RowUpdate,
) {
  updateRow(db, id, state, values);
  return getRequiredWorkerEnvironment(db, id);
}
export function replaceSshFallbackPorts(
  db: DatabaseSync,
  environmentId: string,
  ports: readonly number[],
): void {
  executeSqliteQuerySync(
    db,
    queryWorkerEnvironmentStore(db)
      .deleteFrom("worker_environment_ssh_fallback_ports")
      .where("environment_id", "=", environmentId),
  );
  if (ports.length === 0) {
    return;
  }
  const rows: SshFallbackPortInsert[] = ports.map((port, position) => ({
    environment_id: environmentId,
    position,
    port,
  }));
  executeSqliteQuerySync(
    db,
    queryWorkerEnvironmentStore(db)
      .insertInto("worker_environment_ssh_fallback_ports")
      .values(rows),
  );
}
export function revokeCredential(db: DatabaseSync, environmentId: string): void {
  executeSqliteQuerySync(
    db,
    queryWorkerEnvironmentStore(db)
      .deleteFrom("worker_environment_credentials")
      .where("environment_id", "=", environmentId),
  );
}
export function upsertCredential(db: DatabaseSync, credential: CredentialInsert): void {
  executeSqliteQuerySync(
    db,
    queryWorkerEnvironmentStore(db)
      .insertInto("worker_environment_credentials")
      .values(credential)
      .onConflict((conflict) =>
        conflict.column("environment_id").doUpdateSet({
          credential_hash: credential.credential_hash,
          bundle_hash: credential.bundle_hash,
          session_id: credential.session_id,
          rpc_set_version: credential.rpc_set_version,
          owner_epoch: credential.owner_epoch,
          expires_at_ms: credential.expires_at_ms,
          delivered_at_ms: credential.delivered_at_ms,
        }),
      ),
  );
}
export function credentialInsert(params: {
  input: CredentialInput;
  environmentId: string;
  bundleHash: string;
  attachedSessionIds: readonly string[];
  ownerEpoch: number;
  nowMs: number;
}): CredentialInsert {
  const sessionId = normalizeSessionId(params.input.sessionId);
  assertCredentialSessionBinding(params.attachedSessionIds, sessionId);
  const expiresAtMs = normalizeExpiry(params.input.expiresAtMs);
  if (expiresAtMs <= params.nowMs) {
    throw new Error("Worker credential expiry must be in the future");
  }
  return {
    environment_id: params.environmentId,
    credential_hash: normalizeCredentialHash(params.input.credentialHash),
    bundle_hash: params.bundleHash,
    session_id: sessionId,
    rpc_set_version: normalizeRpcSetVersion(params.input.rpcSetVersion),
    owner_epoch: params.ownerEpoch,
    expires_at_ms: expiresAtMs,
    delivered_at_ms: null,
  };
}
function compareAttachmentAuthority(
  left: WorkerEnvironmentRecord,
  right: WorkerEnvironmentRecord,
): number {
  if (left.ownerEpoch !== right.ownerEpoch) {
    return left.ownerEpoch > right.ownerEpoch ? -1 : 1;
  }
  if (left.stateChangedAtMs !== right.stateChangedAtMs) {
    return left.stateChangedAtMs > right.stateChangedAtMs ? -1 : 1;
  }
  if (left.environmentId === right.environmentId) {
    return 0;
  }
  return left.environmentId < right.environmentId ? -1 : 1;
}

export function reconcileAttachedSessionOwners(db: DatabaseSync, nowMs: number): string[] {
  const ownersBySession = new Map<string, WorkerEnvironmentRecord[]>();
  const changed: string[] = [];
  for (const record of listRows(db)) {
    // Closing attachments retain physical cleanup scope, not live ownership.
    if (record.state !== "attached" || record.destroyRequestedAtMs !== null) {
      continue;
    }
    const sessionId = record.attachedSessionIds[0];
    if (!sessionId) {
      continue;
    }
    const owners = ownersBySession.get(sessionId) ?? [];
    owners.push(record);
    ownersBySession.set(sessionId, owners);
  }
  for (const owners of ownersBySession.values()) {
    if (owners.length < 2) {
      continue;
    }
    const [, ...duplicates] = owners.toSorted(compareAttachmentAuthority);
    for (const duplicate of duplicates) {
      // Fence legacy duplicate live owners before startup snapshots them.
      updateWorkerEnvironmentRecord(db, duplicate.environmentId, "attached", {
        owner_epoch: nextGlobalOwnerEpoch(db),
        state: "idle",
        attached_session_ids_json: json([]),
        updated_at_ms: nowMs,
        state_changed_at_ms: nowMs,
        idle_since_at_ms: nowMs,
      });
      revokeCredential(db, duplicate.environmentId);
      changed.push(duplicate.environmentId);
    }
  }
  return changed;
}
