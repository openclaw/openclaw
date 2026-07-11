import type { DatabaseSync } from "node:sqlite";
import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { Selectable, Updateable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { WorkerProfile, WorkerSshEndpoint } from "../../plugins/types.js";
import { isValidSecretRef } from "../../secrets/ref-contract.js";
import type {
  DB as StateDatabase,
  WorkerEnvironments,
} from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  canTransitionWorkerEnvironment,
  parseWorkerEnvironmentState,
  workerEnvironmentStateRequiresLease,
  type WorkerEnvironmentLeasedState,
  type WorkerEnvironmentState,
  type WorkerEnvironmentUnleasedState,
} from "./state.js";

export type WorkerEnvironmentProfileSnapshot = WorkerProfile;
export type WorkerEnvironmentSshEndpoint = WorkerSshEndpoint;
type RecordIdentity = { environmentId: string; providerId: string; profileId: string };
type RecordBase = RecordIdentity & {
  profileSnapshot: WorkerEnvironmentProfileSnapshot;
  provisionOperationId: string;
  attachedSessionIds: string[];
  lastError: string | null;
} & { createdAtMs: number; updatedAtMs: number; stateChangedAtMs: number } & {
  idleSinceAtMs: number | null;
  destroyRequestedAtMs: number | null;
};
type Ssh = WorkerEnvironmentSshEndpoint;
type UnleasedRecord = { state: WorkerEnvironmentUnleasedState; leaseId: null; sshEndpoint: null };
type LeasedRecord = { state: WorkerEnvironmentLeasedState; leaseId: string; sshEndpoint: Ssh };
export type WorkerEnvironmentRecord = RecordBase & (UnleasedRecord | LeasedRecord);
export type WorkerEnvironmentTransitionPatch = {
  leaseId?: string;
  sshEndpoint?: WorkerEnvironmentSshEndpoint | null;
  attachedSessionIds?: readonly string[];
  lastError?: string | null;
};
type WorkerDb = Pick<StateDatabase, "worker_environments">;
type Row = Selectable<WorkerEnvironments>;
type RowUpdate = Updateable<WorkerEnvironments>;
type IntentInput = RecordIdentity & {
  profileSnapshot: WorkerEnvironmentProfileSnapshot;
  provisionOperationId: string;
};
type TransitionInput = {
  environmentId: string;
  from: WorkerEnvironmentState;
  to: WorkerEnvironmentState;
  patch?: WorkerEnvironmentTransitionPatch;
};
const TERMINAL_STATES: WorkerEnvironmentState[] = ["destroyed", "failed", "orphaned"];
function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Worker environment ${field} must be a non-empty string`);
  }
  return value.trim();
}
export function normalizeWorkerSshEndpoint(value: Ssh): Ssh {
  const host = required(value.host, "SSH host");
  const user = required(value.user, "SSH user");
  if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535) {
    throw new Error("Worker environment SSH port must be an integer from 1 through 65535");
  }
  if (!isValidSecretRef(value.keyRef)) {
    throw new Error("Worker environment SSH key must be a canonical SecretRef");
  }
  return { host, port: value.port, user, keyRef: { ...value.keyRef } };
}
function endpointFrom(row: Row): Ssh | null {
  const { ssh_host: host, ssh_port: port, ssh_user: user, ssh_key_ref_json: encoded } = row;
  if (host === null || port === null || user === null || encoded === null) {
    return null;
  }
  return normalizeWorkerSshEndpoint({
    host,
    port,
    user,
    keyRef: JSON.parse(encoded) as Ssh["keyRef"],
  });
}
function assertShape(
  state: WorkerEnvironmentState,
  leaseId: string | null,
  sshEndpoint: Ssh | null,
  attachedSessionIds: readonly string[],
): void {
  if (workerEnvironmentStateRequiresLease(state)) {
    if (!leaseId) {
      throw new Error(`Worker environment state ${state} requires a provider lease`);
    }
    if (!sshEndpoint) {
      throw new Error("Worker environment provider lease requires an SSH endpoint reference");
    }
  } else if (leaseId || sshEndpoint) {
    throw new Error(`Worker environment state ${state} cannot retain a provider lease`);
  }
  if (state === "attached" && attachedSessionIds.length === 0) {
    throw new Error("Attached worker environment requires at least one session id");
  }
}
function fromRow(row: Row): WorkerEnvironmentRecord {
  const record = {
    environmentId: row.environment_id,
    providerId: row.provider_id,
    profileId: row.profile_id,
    profileSnapshot: JSON.parse(row.profile_snapshot_json) as WorkerEnvironmentProfileSnapshot,
    provisionOperationId: row.provision_operation_id,
    leaseId: row.lease_id,
    sshEndpoint: endpointFrom(row),
    state: parseWorkerEnvironmentState(row.state),
    attachedSessionIds: normalizeSortedUniqueTrimmedStringList(
      JSON.parse(row.attached_session_ids_json) as unknown,
    ),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    stateChangedAtMs: row.state_changed_at_ms,
    idleSinceAtMs: row.idle_since_at_ms,
    destroyRequestedAtMs: row.destroy_requested_at_ms,
    lastError: row.last_error,
  };
  assertShape(record.state, record.leaseId, record.sshEndpoint, record.attachedSessionIds);
  return record as WorkerEnvironmentRecord;
}
const json = (value: unknown) => JSON.stringify(value) as string;
const query = (db: DatabaseSync) => getNodeSqliteKysely<WorkerDb>(db);
function find(db: DatabaseSync, environmentId: string) {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_environments")
      .selectAll()
      .where("environment_id", "=", environmentId),
  );
  return row ? fromRow(row) : undefined;
}
function getRequired(db: DatabaseSync, environmentId: string) {
  const record = find(db, environmentId);
  if (!record) {
    throw new Error(`Unknown worker environment: ${environmentId}`);
  }
  return record;
}
function update(db: DatabaseSync, id: string, state: WorkerEnvironmentState, values: RowUpdate) {
  const result = executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_environments")
      .set(values)
      .where("environment_id", "=", id)
      .where("state", "=", state),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Worker environment ${id} changed during update`);
  }
  return getRequired(db, id);
}
function listRows(db: DatabaseSync, reconcile: boolean): WorkerEnvironmentRecord[] {
  const base = query(db).selectFrom("worker_environments").selectAll();
  const filtered = reconcile ? base.where("state", "not in", TERMINAL_STATES) : base;
  const ordered = reconcile ? filtered.orderBy("provider_id") : filtered;
  return executeSqliteQuerySync(
    db,
    ordered.orderBy("created_at_ms").orderBy("environment_id"),
  ).rows.map(fromRow);
}

export function createWorkerEnvironmentStore(
  options: { database?: OpenClawStateDatabase; now?: () => number } = {},
) {
  const path = (options.database ?? openOpenClawStateDatabase()).path;
  const now = options.now ?? Date.now;
  const read = () => openOpenClawStateDatabase({ path }).db;
  const write = <T>(operation: (db: DatabaseSync) => T): T =>
    runOpenClawStateWriteTransaction(({ db }) => operation(db), { path });
  return {
    createIntent(input: IntentInput): WorkerEnvironmentRecord {
      const environmentId = required(input.environmentId, "id");
      const createdAtMs = now();
      return write((db) => {
        executeSqliteQuerySync(
          db,
          query(db)
            .insertInto("worker_environments")
            .values({
              environment_id: environmentId,
              provider_id: required(input.providerId, "provider id"),
              profile_id: required(input.profileId, "profile id"),
              profile_snapshot_json: json(input.profileSnapshot),
              provision_operation_id: required(
                input.provisionOperationId,
                "provision operation id",
              ),
              lease_id: null,
              ssh_host: null,
              ssh_port: null,
              ssh_user: null,
              ssh_key_ref_json: null,
              state: "requested",
              created_at_ms: createdAtMs,
              updated_at_ms: createdAtMs,
              state_changed_at_ms: createdAtMs,
              idle_since_at_ms: null,
              destroy_requested_at_ms: null,
              last_error: null,
            }),
        );
        return getRequired(db, environmentId);
      });
    },
    get: (environmentId: string) => find(read(), required(environmentId, "id")),
    list: (): WorkerEnvironmentRecord[] => listRows(read(), false),
    listForReconcile: (): WorkerEnvironmentRecord[] => listRows(read(), true),
    requestDestroy(input: { environmentId: string; state: WorkerEnvironmentState }) {
      const environmentId = required(input.environmentId, "id");
      return write((db) => {
        const current = getRequired(db, environmentId);
        if (current.state !== input.state) {
          throw new Error(`Worker environment ${environmentId} changed before destroy request`);
        }
        if (current.destroyRequestedAtMs !== null) {
          return current;
        }
        const requestedAtMs = now();
        return update(db, environmentId, input.state, {
          updated_at_ms: requestedAtMs,
          destroy_requested_at_ms: requestedAtMs,
        });
      });
    },
    transition(input: TransitionInput): WorkerEnvironmentRecord {
      const { from, to, patch = {} } = input;
      if (!canTransitionWorkerEnvironment(from, to)) {
        throw new Error(`Illegal worker environment transition: ${from} -> ${to}`);
      }
      const environmentId = required(input.environmentId, "id");
      const updatedAtMs = now();
      return write((db) => {
        const current = getRequired(db, environmentId);
        if (current.state !== from) {
          throw new Error(
            `Worker environment ${environmentId} state conflict: expected ${from}, found ${current.state}`,
          );
        }
        const leaseId =
          patch.leaseId === undefined ? current.leaseId : required(patch.leaseId, "lease id");
        if (current.leaseId && leaseId !== current.leaseId) {
          throw new Error("Worker environment provider lease id is immutable once persisted");
        }
        const sshEndpoint =
          patch.sshEndpoint === undefined
            ? current.sshEndpoint
            : patch.sshEndpoint === null
              ? null
              : normalizeWorkerSshEndpoint(patch.sshEndpoint);
        const clearsSessions =
          to === "idle" || to === "draining" || to === "destroying" || to === "destroyed";
        const attachedSessionIds = clearsSessions
          ? []
          : patch.attachedSessionIds === undefined
            ? current.attachedSessionIds
            : normalizeSortedUniqueTrimmedStringList(patch.attachedSessionIds);
        assertShape(to, leaseId, sshEndpoint, attachedSessionIds);
        return update(db, environmentId, from, {
          lease_id: leaseId,
          ssh_host: sshEndpoint?.host ?? null,
          ssh_port: sshEndpoint?.port ?? null,
          ssh_user: sshEndpoint?.user ?? null,
          ssh_key_ref_json: sshEndpoint ? json(sshEndpoint.keyRef) : null,
          state: to,
          attached_session_ids_json: json(attachedSessionIds),
          updated_at_ms: updatedAtMs,
          state_changed_at_ms: updatedAtMs,
          idle_since_at_ms: to === "idle" ? updatedAtMs : null,
          last_error: "lastError" in patch ? patch.lastError?.trim() || null : null,
        });
      });
    },
    recordError(input: { environmentId: string; state: WorkerEnvironmentState; error: string }) {
      return write((db) =>
        update(db, required(input.environmentId, "id"), input.state, {
          updated_at_ms: now(),
          last_error: required(input.error, "last error"),
        }),
      );
    },
  };
}

export type WorkerEnvironmentStore = ReturnType<typeof createWorkerEnvironmentStore>;
