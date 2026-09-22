import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type {
  WorkerDesktopEndpoint,
  WorkerProfile,
  WorkerSshEndpoint,
} from "../../plugins/capability-provider.types.js";
import type {
  DB as StateDatabase,
  WorkerEnvironmentCredentials,
  WorkerEnvironments,
} from "../../state/openclaw-state-db.generated.js";
import type { WorkerCredentialRecord } from "./credential.js";
import { normalizeWorkerDesktopEndpoint } from "./desktop-endpoint.js";
import type {
  WorkerEnvironmentBootstrapReceipt,
  WorkerEnvironmentRecord,
  WorkerEnvironmentTeardownTerminalState,
} from "./environment-record.js";
import { readWorkerEnvironmentPreparation } from "./prepared-environment-store.js";
import { readWorkerEnvironmentSessionAttachments } from "./session-attachment-store.js";
import { parseWorkerEnvironmentState } from "./state.js";
import {
  assertShape,
  normalizeAttachedSessionIds,
  normalizeBootstrapReceipt,
  normalizeCredentialHash,
  normalizeWorkerSshEndpoint,
} from "./store-validation.js";
import type {
  WorkerEnvironmentFacts,
  WorkerEnvironmentPruneReadInput,
  WorkerEnvironmentPrunePage,
} from "./store-worker-contract.js";
import { readTerminalWorkerEnvironmentPrunePage } from "./terminal-environment-retention.js";
type Ssh = WorkerSshEndpoint;
type WorkerEnvironmentProfileSnapshot = WorkerProfile;

type WorkerDb = Pick<
  StateDatabase,
  | "device_pair_setup_completions"
  | "worker_environment_credentials"
  | "worker_environment_ssh_fallback_ports"
  | "worker_environments"
  | "worker_session_placement_moves"
  | "worker_session_placements"
  | "worker_transcript_commit_heads"
>;
type Row = Selectable<WorkerEnvironments>;
type RowWithFallbackPorts = Row & { ssh_fallback_ports_json: string };
type CredentialRow = Selectable<WorkerEnvironmentCredentials>;
function teardownTerminalStateFrom(
  value: string | null,
): WorkerEnvironmentTeardownTerminalState | null {
  if (value === null || value === "destroyed" || value === "failed") {
    return value;
  }
  throw new Error("Worker environment teardown terminal state is invalid");
}
function endpointFrom(row: Row, fallbackPorts: readonly number[]): Ssh | null {
  const {
    ssh_host: host,
    ssh_port: port,
    ssh_user: user,
    ssh_host_key: hostKey,
    ssh_key_ref_json: encoded,
  } = row;
  if (host === null || port === null || user === null || hostKey === null || encoded === null) {
    return null;
  }
  return normalizeWorkerSshEndpoint({
    host,
    port,
    ...(fallbackPorts.length > 0 ? { fallbackPorts } : {}),
    user,
    hostKey,
    // SAFETY: normalizeWorkerSshEndpoint validates this value with isValidSecretRef.
    keyRef: JSON.parse(encoded) as Ssh["keyRef"],
  });
}
function desktopFrom(row: Row): WorkerDesktopEndpoint | null {
  if (row.desktop_json === null) {
    return null;
  }
  // SAFETY: normalizeWorkerDesktopEndpoint validates every decoded endpoint field.
  return normalizeWorkerDesktopEndpoint(JSON.parse(row.desktop_json) as WorkerDesktopEndpoint);
}
function bootstrapReceiptFrom(row: Row): WorkerEnvironmentBootstrapReceipt | null {
  const {
    bootstrap_bundle_hash: bundleHash,
    bootstrap_openclaw_version: openclawVersion,
    bootstrap_protocol_features_json: encodedFeatures,
    bootstrap_install_kind: installKind,
  } = row;
  if (bundleHash === null && openclawVersion === null && encodedFeatures === null) {
    return null;
  }
  if (bundleHash === null || openclawVersion === null || encodedFeatures === null) {
    throw new Error("Worker environment bootstrap receipt is incomplete");
  }
  return normalizeBootstrapReceipt({
    bundleHash,
    openclawVersion,
    protocolFeatures: JSON.parse(encodedFeatures) as unknown,
    ...(installKind === null ? {} : { installKind }),
  });
}
export function decodeWorkerEnvironmentRow(
  row: Row,
  fallbackPorts: readonly number[],
): WorkerEnvironmentRecord {
  const record = {
    environmentId: row.environment_id,
    providerId: row.provider_id,
    profileId: row.profile_id,
    // SAFETY: this store writes profile_snapshot_json from its typed profile snapshot.
    profileSnapshot: JSON.parse(row.profile_snapshot_json) as WorkerEnvironmentProfileSnapshot,
    preparation: readWorkerEnvironmentPreparation(row),
    provisionOperationId: row.provision_operation_id,
    nodeSetupId: row.node_setup_id,
    nodeDeviceId: row.node_device_id,
    sharedHost: row.shared_host === null ? null : row.shared_host === 1,
    leaseId: row.lease_id,
    sshEndpoint: endpointFrom(row, fallbackPorts),
    desktop: desktopFrom(row),
    bootstrapReceipt: bootstrapReceiptFrom(row),
    ownerEpoch: row.owner_epoch,
    teardownTerminalState: teardownTerminalStateFrom(row.teardown_terminal_state),
    state: parseWorkerEnvironmentState(row.state),
    attachedSessionIds: normalizeAttachedSessionIds(
      JSON.parse(row.attached_session_ids_json) as unknown,
    ),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    stateChangedAtMs: row.state_changed_at_ms,
    lastActivatedAtMs: row.last_activated_at_ms,
    idleSinceAtMs: row.idle_since_at_ms,
    destroyRequestedAtMs: row.destroy_requested_at_ms,
    lastError: row.last_error,
  };
  assertShape(
    record.state,
    record.leaseId,
    record.nodeDeviceId,
    record.sshEndpoint,
    record.desktop,
    record.bootstrapReceipt,
    record.attachedSessionIds,
  );
  // SAFETY: assertShape validates the state's lease, transport, and attachment invariants.
  return record as WorkerEnvironmentRecord;
}
function credentialFromRow(row: CredentialRow): WorkerCredentialRecord {
  return {
    environmentId: row.environment_id,
    credentialHash: normalizeCredentialHash(row.credential_hash),
    bundleHash: row.bundle_hash,
    sessionId: row.session_id,
    rpcSetVersion: row.rpc_set_version,
    ownerEpoch: row.owner_epoch,
    expiresAtMs: row.expires_at_ms,
    deliveredAtMs: row.delivered_at_ms,
  };
}
export function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Worker environment value must be JSON serializable");
  }
  return encoded;
}
export const queryWorkerEnvironmentStore = (db: DatabaseSync) => getNodeSqliteKysely<WorkerDb>(db);
function environmentRows(db: DatabaseSync) {
  return queryWorkerEnvironmentStore(db)
    .selectFrom("worker_environments")
    .selectAll("worker_environments")
    .select((eb) =>
      eb
        .selectFrom("worker_environment_ssh_fallback_ports")
        .select(({ fn }) =>
          fn.agg<string>("json_group_array", ["port"]).orderBy("position").as("ports"),
        )
        .whereRef(
          "worker_environment_ssh_fallback_ports.environment_id",
          "=",
          "worker_environments.environment_id",
        )
        .$asScalar()
        .as("ssh_fallback_ports_json"),
    );
}
function recordsFromRows(rows: readonly RowWithFallbackPorts[]): WorkerEnvironmentRecord[] {
  return rows.map((row) =>
    // SAFETY: SQLite aggregates the numeric port column; endpointFrom validates the decoded ports.
    decodeWorkerEnvironmentRow(row, JSON.parse(row.ssh_fallback_ports_json) as number[]),
  );
}
export function findWorkerEnvironment(db: DatabaseSync, environmentId: string) {
  const rows = executeSqliteQuerySync(
    db,
    environmentRows(db).where("worker_environments.environment_id", "=", environmentId),
  ).rows;
  return recordsFromRows(rows)[0];
}
export function findCredential(db: DatabaseSync, environmentId: string) {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    queryWorkerEnvironmentStore(db)
      .selectFrom("worker_environment_credentials")
      .selectAll()
      .where("environment_id", "=", environmentId),
  );
  return row ? credentialFromRow(row) : undefined;
}
export function getRequiredWorkerEnvironment(db: DatabaseSync, environmentId: string) {
  const record = findWorkerEnvironment(db, environmentId);
  if (!record) {
    throw new Error(`Unknown worker environment: ${environmentId}`);
  }
  return record;
}
export function listRows(db: DatabaseSync): WorkerEnvironmentRecord[] {
  const rows = executeSqliteQuerySync(
    db,
    environmentRows(db)
      .orderBy("worker_environments.created_at_ms")
      .orderBy("worker_environments.environment_id"),
  ).rows;
  return recordsFromRows(rows);
}

/** Prepared inside the owning transaction; absent rows are explicit deletion facts. */
export function readWorkerEnvironmentFacts(
  db: DatabaseSync,
  ids?: readonly string[],
): WorkerEnvironmentFacts {
  const environments = ids
    ? ids.flatMap((id) => {
        const row = findWorkerEnvironment(db, id);
        return row ? [row] : [];
      })
    : listRows(db);
  const credentialQuery = queryWorkerEnvironmentStore(db)
    .selectFrom("worker_environment_credentials")
    .selectAll();
  const credentials =
    ids?.length === 0
      ? []
      : executeSqliteQuerySync(
          db,
          ids ? credentialQuery.where("environment_id", "in", ids) : credentialQuery,
        ).rows.map(credentialFromRow);
  const attachments = readWorkerEnvironmentSessionAttachments(db, ids);
  return {
    ids: ids ? [...ids] : environments.map((row) => row.environmentId),
    environments,
    credentials,
    attachments,
  };
}

export function readWorkerEnvironmentPrunePage(
  db: DatabaseSync,
  input: WorkerEnvironmentPruneReadInput,
): WorkerEnvironmentPrunePage {
  const { rows, ...page } = readTerminalWorkerEnvironmentPrunePage(db, input);
  return {
    ...page,
    candidates: rows.map((observed) => ({
      observed,
      record: decodeWorkerEnvironmentRow(observed, []),
    })),
  };
}
