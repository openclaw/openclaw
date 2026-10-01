import type { DatabaseSync } from "node:sqlite";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { Selectable, Updateable } from "kysely";
import { z } from "zod";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { createOpenClawStateSchemaEnsurer } from "../state/openclaw-state-feature-schema.js";
import { loadPairedDevicePairingStoreRecordFromDatabase } from "./device-pairing-store.js";
import { resolveNodePairingState } from "./device-pairing.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { isLikelyApnsToken, isValidApnsTopic } from "./push-apns-store.js";
import { normalizePersistedApnsRelayBaseUrl } from "./push-apns.relay.js";

export const TABLE = "apns_live_activities";
export const LEASE_MS = 8 * 60 * 60 * 1_000;
const TOMBSTONE_MS = 24 * 60 * 60 * 1_000;
export const TERMINAL_RETRY_MS = 5 * 60 * 1_000;
const PROGRESS_INTERVAL_MS = 5_000;
export const LIVE_ACTIVITY_MAX_ATTEMPT_MS = 30_000;
export const MAX_ROWS = 4_096;
export const MAX_GATEWAY_ACTIVITIES = 256;
export const MAX_DEVICE_ACTIVITIES = 8;
export const MAX_SNAPSHOT_BYTES = 2_048;
export const MAX_DESTINATION_BYTES = 8_192;
export const ensureSchema = createOpenClawStateSchemaEnsurer({
  table: TABLE,
  endMarker:
    "\n  ON apns_live_activities(state, lease_expires_at_ms, terminal_deadline_ms, tombstone_expires_at_ms);\n",
  operationLabel: "apns.live-activity.schema",
});

type ActivityDatabase = Pick<DB, typeof TABLE>;
export type ActivityRow = Selectable<ActivityDatabase[typeof TABLE]>;
type ActivityUpdate = Updateable<ActivityDatabase[typeof TABLE]>;
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestampMs = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const text = (max: number) =>
  z
    .string()
    .min(1)
    .refine((value) => {
      let length = 0;
      for (const scalar of value) {
        length++;
        const codeUnit = scalar.charCodeAt(0);
        // String iteration keeps valid surrogate pairs together.
        if (
          length > max ||
          codeUnit < 0x20 ||
          (scalar.length === 1 && codeUnit >= 0xd800 && codeUnit <= 0xdfff)
        ) {
          return false;
        }
      }
      return true;
    });
export const bindingSchema = z.strictObject({
  gatewayId: text(256),
  deviceId: text(256),
  nodeId: text(256),
  pairingGeneration: z.string().regex(/^[0-9a-f]{64}$/),
  profileId: text(128),
  agentId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  sessionKey: text(512),
  sessionId: text(128),
  lifecycleRevision: text(256).nullable(),
  publicRunId: text(256),
});
const destinationBase = {
  topic: text(255).refine((value) => value === value.trim() && isValidApnsTopic(value)),
  environment: z.enum(["sandbox", "production"]),
};
export const destinationSchema = z.discriminatedUnion("transport", [
  z.strictObject({
    transport: z.literal("direct"),
    token: z
      .string()
      .regex(/^[0-9a-f]+$/)
      .refine(isLikelyApnsToken),
    ...destinationBase,
  }),
  z.strictObject({
    transport: z.literal("relay"),
    relayHandle: text(256),
    sendGrant: text(1024),
    installationId: text(256),
    relayOrigin: z
      .string()
      .max(2048)
      .refine((value) => {
        const normalized = normalizePersistedApnsRelayBaseUrl(value);
        return normalized.ok && normalized.value === value;
      }),
    relayRevision: integer.min(1),
    ...destinationBase,
  }),
]);
const factBase = {
  sourceIncarnation: text(1024),
  sequence: integer,
  observedAtMs: timestampMs,
  startedAtMs: timestampMs.optional(),
};
const progressFactSchema = z.strictObject({
  ...factBase,
  status: z.enum(["running", "toolRunning", "approvalNeeded"]),
});
const terminalFactSchema = z.strictObject({
  ...factBase,
  status: z.enum(["done", "failed", "killed", "timeout"]),
  endedAtMs: timestampMs.optional(),
});
function validFactTimes(fact: {
  observedAtMs: number;
  startedAtMs?: number;
  endedAtMs?: number;
}): boolean {
  return (
    (fact.startedAtMs === undefined || fact.startedAtMs <= fact.observedAtMs) &&
    (fact.endedAtMs === undefined ||
      (fact.endedAtMs <= fact.observedAtMs &&
        (fact.startedAtMs === undefined || fact.endedAtMs >= fact.startedAtMs)))
  );
}
export const snapshotSchema = z
  .union([progressFactSchema, terminalFactSchema])
  .refine(validFactTimes);
export const observationSchema = z
  .union([progressFactSchema, terminalFactSchema.omit({ sequence: true })])
  .refine(validFactTimes);
export const registrationSchema = z.strictObject({
  activityId: text(256),
  binding: bindingSchema,
  sourceIncarnation: factBase.sourceIncarnation,
  destination: destinationSchema,
});

export type LiveActivityBinding = z.infer<typeof bindingSchema>;
export type LiveActivityDestination = z.infer<typeof destinationSchema>;
export type LiveActivitySnapshot = z.infer<typeof snapshotSchema>;
/** Terminal observations require the canonical committed owner, not a producer sequence. */
export type LiveActivityObservation = z.infer<typeof observationSchema>;
export type LiveActivityRegistrationInput = z.infer<typeof registrationSchema>;
export type LiveActivityRetirementReason =
  | "revoked"
  | "owner-retired"
  | "lease-expired"
  | "terminal-expired"
  | "terminal-delivered"
  | "delivery-rejected";
type LiveActivityStoreError =
  | "invalid-input"
  | "snapshot-too-large"
  | "not-found"
  | "binding-conflict"
  | "retired"
  | "owner-changed"
  | "revision-conflict"
  | "revision-exhausted"
  | "source-changed"
  | "out-of-order"
  | "capacity"
  | "not-due"
  | "stale-claim"
  | "clock-regressed"
  | "closed";
export type StoreResult<T> = Result<T, LiveActivityStoreError>;
export type LiveActivityRegistration = Readonly<{
  registrationId: string;
  activityId: string;
  binding: Readonly<LiveActivityBinding>;
  sourceIncarnation: string;
  state: "active" | "terminal_pending" | "tombstone";
  rotationRevision: number;
  deliveryRevision: number;
  createdAtMs: number;
  leaseExpiresAtMs: number;
  terminalDeadlineMs: number | null;
  nextAttemptAtMs: number | null;
  snapshot: Readonly<LiveActivitySnapshot> | null;
}>;
/**
 * Read live owner state synchronously using this transaction's borrowed database.
 * The callback is read-only: do not mutate, retain, close, or replace the handle.
 */
export type LiveActivityOwnerIsCurrent = (
  binding: Readonly<LiveActivityBinding>,
  sourceIncarnation: string,
  db: DatabaseSync,
) => boolean;
export type LiveActivityDeliveryState = "ready" | "held" | "lost";
/** Same borrowed-handle contract as LiveActivityOwnerIsCurrent; held is not owner loss. */
export type LiveActivityDeliveryOwner = (
  binding: Readonly<LiveActivityBinding>,
  sourceIncarnation: string,
  db: DatabaseSync,
) => LiveActivityDeliveryState;
export type LiveActivityClaim = Readonly<{
  registration: LiveActivityRegistration;
  destination: Readonly<LiveActivityDestination>;
  snapshot: Readonly<LiveActivitySnapshot>;
  claimId: string;
  dispatchRevision: number;
  timestampSeconds: number;
  attemptDeadlineMs: number;
}>;

export function stateDb(db: DatabaseSync) {
  return getNodeSqliteKysely<ActivityDatabase>(db);
}

export function bindingColumns(binding: LiveActivityBinding) {
  return {
    gateway_id: binding.gatewayId,
    device_id: binding.deviceId,
    node_id: binding.nodeId,
    pairing_generation: binding.pairingGeneration,
    profile_id: binding.profileId,
    agent_id: binding.agentId,
    session_key: binding.sessionKey,
    session_id: binding.sessionId,
    lifecycle_revision: binding.lifecycleRevision,
    public_run_id: binding.publicRunId,
  };
}

function rowBinding(row: ActivityRow): LiveActivityBinding {
  return {
    gatewayId: row.gateway_id,
    deviceId: row.device_id,
    nodeId: row.node_id,
    pairingGeneration: row.pairing_generation,
    profileId: row.profile_id,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    lifecycleRevision: row.lifecycle_revision,
    publicRunId: row.public_run_id,
  };
}

export function sameBinding(row: ActivityRow, binding: LiveActivityBinding): boolean {
  return JSON.stringify(rowBinding(row)) === JSON.stringify(binding);
}

export function parseSnapshot(row: ActivityRow): LiveActivitySnapshot | null {
  if (row.snapshot_json === null) {
    return null;
  }
  try {
    return snapshotSchema.parse(JSON.parse(row.snapshot_json));
  } catch {
    throw new Error("Invalid stored Live Activity snapshot");
  }
}

export function parseDestination(row: ActivityRow): LiveActivityDestination {
  try {
    return destinationSchema.parse(JSON.parse(row.destination_json ?? "null"));
  } catch {
    throw new Error("Invalid stored Live Activity destination");
  }
}

export function registration(row: ActivityRow): LiveActivityRegistration {
  if (row.state !== "active" && row.state !== "terminal_pending" && row.state !== "tombstone") {
    throw new Error("Invalid stored Live Activity state");
  }
  const snapshot = parseSnapshot(row);
  return Object.freeze({
    registrationId: row.registration_id,
    activityId: row.activity_id,
    binding: Object.freeze(rowBinding(row)),
    sourceIncarnation: row.source_incarnation,
    state: row.state,
    rotationRevision: row.rotation_revision,
    deliveryRevision: row.delivery_revision,
    createdAtMs: row.created_at_ms,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    terminalDeadlineMs: row.terminal_deadline_ms,
    nextAttemptAtMs: row.next_attempt_at_ms,
    snapshot: snapshot ? Object.freeze(snapshot) : null,
  });
}

export function terminal(fact: LiveActivitySnapshot): boolean {
  return (
    fact.status === "done" ||
    fact.status === "failed" ||
    fact.status === "killed" ||
    fact.status === "timeout"
  );
}

export function nowMs(): number {
  const now = Date.now();
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - LEASE_MS - TOMBSTONE_MS
  ) {
    throw new Error("Live Activity clock is outside the supported range");
  }
  return now;
}

export function readRow(db: DatabaseSync, id: string): ActivityRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    stateDb(db).selectFrom(TABLE).selectAll().where("registration_id", "=", id),
  );
}

export function readActivityRow(
  db: DatabaseSync,
  binding: Pick<LiveActivityBinding, "gatewayId" | "deviceId">,
  activityId: string,
): ActivityRow | undefined {
  if (!tableExists(db, TABLE)) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    db,
    stateDb(db)
      .selectFrom(TABLE)
      .selectAll()
      .where("gateway_id", "=", binding.gatewayId)
      .where("device_id", "=", binding.deviceId)
      .where("activity_id", "=", activityId),
  );
}

export function updateRow(db: DatabaseSync, id: string, update: ActivityUpdate): ActivityRow {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    stateDb(db).updateTable(TABLE).set(update).where("registration_id", "=", id).returningAll(),
  );
  if (!row) {
    throw new Error("Live Activity disappeared inside its write transaction");
  }
  return row;
}

export const clearedClaim = {
  claim_id: null,
  claim_runtime_id: null,
  claim_deadline_ms: null,
  claim_authorized_at_ms: null,
};

export function retire(
  db: DatabaseSync,
  row: ActivityRow,
  reason: LiveActivityRetirementReason,
  at: number,
  now: number,
): ActivityRow {
  return updateRow(db, row.registration_id, {
    ...clearedClaim,
    state: "tombstone",
    destination_json: null,
    snapshot_json: null,
    delivery_timestamp_s: null,
    next_attempt_at_ms: null,
    retired_at_ms: at,
    tombstone_expires_at_ms: at + TOMBSTONE_MS,
    retirement_reason: reason,
    updated_at_ms: now,
  });
}

export function expiry(row: ActivityRow, now: number): LiveActivityRetirementReason | undefined {
  if (now >= row.lease_expires_at_ms) {
    return "lease-expired";
  }
  if (row.terminal_deadline_ms !== null && now >= row.terminal_deadline_ms) {
    return "terminal-expired";
  }
  return undefined;
}

export function sweepRows(db: DatabaseSync, now: number): StoreResult<number> {
  if (
    executeSqliteQueryTakeFirstSync(
      db,
      stateDb(db)
        .selectFrom(TABLE)
        .select("registration_id")
        .where("updated_at_ms", ">", now)
        .limit(1),
    )
  ) {
    return err("clock-regressed");
  }
  const rows = executeSqliteQuerySync(
    db,
    stateDb(db)
      .selectFrom(TABLE)
      .selectAll()
      .where("state", "!=", "tombstone")
      .where((eb) =>
        eb.or([eb("lease_expires_at_ms", "<=", now), eb("terminal_deadline_ms", "<=", now)]),
      ),
  ).rows;
  for (const row of rows) {
    const at = Math.min(row.lease_expires_at_ms, row.terminal_deadline_ms ?? Infinity);
    retire(db, row, expiry(row, now) ?? "lease-expired", at, now);
  }
  const removed = executeSqliteQuerySync(
    db,
    stateDb(db)
      .deleteFrom(TABLE)
      .where("state", "=", "tombstone")
      .where("tombstone_expires_at_ms", "<=", now),
  );
  return ok(rows.length + Number(removed.numAffectedRows ?? 0n));
}

export function ownerCurrent(
  db: DatabaseSync,
  row: ActivityRow,
  isCurrent: LiveActivityOwnerIsCurrent,
): boolean {
  const binding = Object.freeze(rowBinding(row));
  try {
    switch (isCurrent(binding, row.source_incarnation, db)) {
      case true:
        break;
      default:
        return false;
    }
  } catch {
    return false;
  }
  // The device writer can replace its complete table. Re-read both node identity
  // and node-surface generation; device-wide approval timestamps are not owners.
  const paired = resolveNodePairingState(
    loadPairedDevicePairingStoreRecordFromDatabase(db, binding.deviceId),
  );
  if (
    paired?.identity.nodeId !== binding.deviceId ||
    paired.identity.nodeId !== binding.nodeId ||
    paired.generation?.nodeId !== binding.nodeId ||
    paired.generation.key !== binding.pairingGeneration
  ) {
    return false;
  }
  return true;
}

export function deliveryOwnerCurrent(
  db: DatabaseSync,
  row: ActivityRow,
  owner: LiveActivityDeliveryOwner,
): LiveActivityDeliveryState {
  let state: LiveActivityDeliveryState = "lost";
  const current = ownerCurrent(db, row, (binding, incarnation, ownerDb) => {
    const result = owner(binding, incarnation, ownerDb);
    if (result !== "ready" && result !== "held") {
      return false;
    }
    state = result;
    return true;
  });
  // A held terminal write still requires the exact current node pairing.
  return current ? state : "lost";
}

export function matchesClaim(
  row: ActivityRow,
  claim: LiveActivityClaim,
  runtimeId: string,
  now: number,
): boolean {
  return (
    row.state !== "tombstone" &&
    row.claim_id === claim.claimId &&
    row.claim_runtime_id === runtimeId &&
    row.rotation_revision === claim.registration.rotationRevision &&
    row.delivery_revision === claim.registration.deliveryRevision &&
    row.delivery_timestamp_s === claim.timestampSeconds &&
    row.claim_deadline_ms === claim.attemptDeadlineMs &&
    now < claim.attemptDeadlineMs &&
    row.dispatch_revision === claim.dispatchRevision
  );
}

export function nextProgress(row: ActivityRow, now: number): number {
  return Math.max(
    now,
    row.last_attempt_at_ms === null ? now : row.last_attempt_at_ms + PROGRESS_INTERVAL_MS,
  );
}
