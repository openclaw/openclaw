// Shared-state registry for live local session enrollments: which verified team
// profile publishes which native catalog from which paired device, plus the
// per-thread exclusions that survive re-enrollment.
import { randomUUID } from "node:crypto";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { withOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { ensureLocalSessionSchema } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";

type LocalSessionDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "local_session_enrollments" | "local_session_exclusions" | "local_session_connect_intents"
>;
type EnrollmentRow = Selectable<OpenClawStateKyselyDatabase["local_session_enrollments"]>;

export type LocalSessionEnrollmentState = "pending" | "active" | "declined" | "revoked" | "expired";

export type LocalSessionEnrollment = {
  enrollmentId: string;
  ownerProfileId: string;
  ownerLabel: string;
  deviceId: string;
  pluginId: string;
  sourceId: string;
  agentId: string;
  state: LocalSessionEnrollmentState;
  requestedAtMs: number;
  expiresAtMs: number;
  confirmedAtMs?: number;
  endedAtMs?: number;
  reason?: string /** Pairing setup of the profile-minted connect link that created this row. */;
  setupId?: string;
};

/** A pending offer the device never answered expires; the row stays as a visible outcome. */
const LOCAL_SESSION_ENROLLMENT_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

function kysely(db: Parameters<typeof getNodeSqliteKysely>[0]) {
  return getNodeSqliteKysely<LocalSessionDatabase>(db);
}

function rowToEnrollment(row: EnrollmentRow): LocalSessionEnrollment {
  return {
    enrollmentId: row.enrollment_id,
    ownerProfileId: row.owner_profile_id,
    ownerLabel: row.owner_label,
    deviceId: row.device_id,
    pluginId: row.plugin_id,
    sourceId: row.source_id,
    agentId: row.agent_id,
    // SAFETY: column has a CHECK constraint limiting it to the enrollment states.
    state: row.state as LocalSessionEnrollmentState,
    requestedAtMs: row.requested_at_ms,
    expiresAtMs: row.expires_at_ms,
    ...(row.confirmed_at_ms === null ? {} : { confirmedAtMs: row.confirmed_at_ms }),
    ...(row.ended_at_ms === null ? {} : { endedAtMs: row.ended_at_ms }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.setup_id === null ? {} : { setupId: row.setup_id }),
  };
}

function isLive(state: LocalSessionEnrollmentState): boolean {
  return state === "pending" || state === "active";
}

export function listLocalSessionEnrollments(
  filter: { deviceId?: string; sourceId?: string; ownerProfileId?: string } = {},
  options: OpenClawStateDatabaseOptions = {},
): LocalSessionEnrollment[] {
  return withOpenClawStateDatabaseReadOnly(({ db }) => {
    if (!tableExists(db, "local_session_enrollments")) {
      return [];
    }
    let query = kysely(db).selectFrom("local_session_enrollments").selectAll();
    if (filter.deviceId) {
      query = query.where("device_id", "=", filter.deviceId);
    }
    if (filter.sourceId) {
      query = query.where("source_id", "=", filter.sourceId);
    }
    if (filter.ownerProfileId) {
      query = query.where("owner_profile_id", "=", filter.ownerProfileId);
    }
    return executeSqliteQuerySync(db, query.orderBy("requested_at_ms", "desc")).rows.map(
      rowToEnrollment,
    );
  }, options);
}

export function readLocalSessionEnrollment(
  enrollmentId: string,
  options: OpenClawStateDatabaseOptions = {},
): LocalSessionEnrollment | undefined {
  return listLocalSessionEnrollments({}, options).find(
    (enrollment) => enrollment.enrollmentId === enrollmentId,
  );
}

/**
 * Create a pending enrollment. One live enrollment per device/source: a still-live
 * row for the same pair is ended first so the device sees exactly one offer.
 */
export function createLocalSessionEnrollment(
  input: {
    ownerProfileId: string;
    ownerLabel: string;
    deviceId: string;
    pluginId: string;
    sourceId: string;
    agentId: string;
    setupId?: string;
  },
  options: OpenClawStateDatabaseOptions = {},
): LocalSessionEnrollment {
  const now = Date.now();
  const enrollment: LocalSessionEnrollment = {
    enrollmentId: randomUUID(),
    ...input,
    state: "pending",
    requestedAtMs: now,
    expiresAtMs: now + LOCAL_SESSION_ENROLLMENT_PENDING_TTL_MS,
  };
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensureLocalSessionSchema(db);
      const store = kysely(db);
      executeSqliteQuerySync(
        db,
        store
          .updateTable("local_session_enrollments")
          .set({ state: "revoked", ended_at_ms: now, reason: "replaced by a new request" })
          .where("device_id", "=", input.deviceId)
          .where("source_id", "=", input.sourceId)
          .where("state", "in", ["pending", "active"]),
      );
      executeSqliteQuerySync(
        db,
        store.insertInto("local_session_enrollments").values({
          enrollment_id: enrollment.enrollmentId,
          owner_profile_id: enrollment.ownerProfileId,
          owner_label: enrollment.ownerLabel,
          device_id: enrollment.deviceId,
          plugin_id: enrollment.pluginId,
          source_id: enrollment.sourceId,
          agent_id: enrollment.agentId,
          state: "pending",
          requested_at_ms: now,
          expires_at_ms: enrollment.expiresAtMs,
          confirmed_at_ms: null,
          ended_at_ms: null,
          reason: null,
          setup_id: input.setupId ?? null,
        }),
      );
    },
    options,
    { operationLabel: "local-session-enrollments.create" },
  );
  return enrollment;
}

/** Move a pending enrollment to its device-decided or Gateway-decided terminal/active state. */
export function transitionLocalSessionEnrollment(
  params: {
    enrollmentId: string;
    to: Exclude<LocalSessionEnrollmentState, "pending">;
    reason?: string;
  },
  options: OpenClawStateDatabaseOptions = {},
): LocalSessionEnrollment | undefined {
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensureLocalSessionSchema(db);
      const store = kysely(db);
      const current = executeSqliteQuerySync(
        db,
        store
          .selectFrom("local_session_enrollments")
          .selectAll()
          .where("enrollment_id", "=", params.enrollmentId),
      ).rows[0];
      if (!current) {
        return undefined;
      }
      // SAFETY: column has a CHECK constraint limiting it to the enrollment states.
      const currentState = current.state as LocalSessionEnrollmentState;
      // Activation needs a pending offer; revocation applies to any live row; the
      // rest are terminal and idempotent.
      if (params.to === "active" && currentState !== "pending") {
        return rowToEnrollment(current);
      }
      // The offer advertised a deadline; a late acceptance must not start publishing.
      if (params.to === "active" && current.expires_at_ms <= now) {
        const expired = { state: "expired" as const, ended_at_ms: now, reason: "offer expired" };
        executeSqliteQuerySync(
          db,
          store
            .updateTable("local_session_enrollments")
            .set(expired)
            .where("enrollment_id", "=", params.enrollmentId),
        );
        return rowToEnrollment({ ...current, ...expired });
      }
      if (!isLive(currentState)) {
        return rowToEnrollment(current);
      }
      const patch =
        params.to === "active"
          ? { state: "active" as const, confirmed_at_ms: now }
          : {
              state: params.to,
              ended_at_ms: now,
              ...(params.reason !== undefined ? { reason: params.reason } : {}),
            };
      executeSqliteQuerySync(
        db,
        store
          .updateTable("local_session_enrollments")
          .set(patch)
          .where("enrollment_id", "=", params.enrollmentId),
      );
      return rowToEnrollment({ ...current, ...patch });
    },
    options,
    { operationLabel: "local-session-enrollments.transition" },
  );
}

export function listLocalSessionExclusions(
  filter: { deviceId: string; sourceId: string },
  options: OpenClawStateDatabaseOptions = {},
): string[] {
  return withOpenClawStateDatabaseReadOnly(({ db }) => {
    if (!tableExists(db, "local_session_exclusions")) {
      return [];
    }
    return executeSqliteQuerySync(
      db,
      kysely(db)
        .selectFrom("local_session_exclusions")
        .select("thread_id")
        .where("device_id", "=", filter.deviceId)
        .where("source_id", "=", filter.sourceId),
    ).rows.map((row) => row.thread_id);
  }, options);
}

export function setLocalSessionExclusion(
  params: {
    deviceId: string;
    sourceId: string;
    threadId: string;
    excluded: boolean;
    byProfileId: string;
  },
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensureLocalSessionSchema(db);
      const store = kysely(db);
      if (!params.excluded) {
        executeSqliteQuerySync(
          db,
          store
            .deleteFrom("local_session_exclusions")
            .where("device_id", "=", params.deviceId)
            .where("source_id", "=", params.sourceId)
            .where("thread_id", "=", params.threadId),
        );
        return;
      }
      executeSqliteQuerySync(
        db,
        store
          .insertInto("local_session_exclusions")
          .values({
            device_id: params.deviceId,
            source_id: params.sourceId,
            thread_id: params.threadId,
            excluded_by_profile_id: params.byProfileId,
            excluded_at_ms: Date.now(),
          })
          .onConflict((conflict) => conflict.doNothing()),
      );
    },
    options,
    { operationLabel: "local-session-exclusions.set" },
  );
}

export type LocalSessionConnectIntent = {
  setupId: string;
  ownerProfileId: string;
  ownerLabel: string;
  agentId: string;
  sourceIds: string[];
  createdAtMs: number;
  expiresAtMs: number;
};

/** Remember what a profile-minted connect link is meant to share once its device pairs. */
export function createLocalSessionConnectIntent(
  intent: LocalSessionConnectIntent,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    ensureLocalSessionSchema(db);
    executeSqliteQuerySync(
      db,
      kysely(db)
        .insertInto("local_session_connect_intents")
        .values({
          setup_id: intent.setupId,
          owner_profile_id: intent.ownerProfileId,
          owner_label: intent.ownerLabel,
          agent_id: intent.agentId,
          source_ids_json: JSON.stringify(intent.sourceIds),
          created_at_ms: intent.createdAtMs,
          expires_at_ms: intent.expiresAtMs,
          activated_device_id: null,
          activated_at_ms: null,
        }),
    );
  }, options);
}

/**
 * Claim the intent for the device that redeemed its setup: exactly one device
 * activates it, and only while the link's own deadline still holds.
 */
export function activateLocalSessionConnectIntent(
  params: { setupId: string; deviceId: string },
  options: OpenClawStateDatabaseOptions = {},
): LocalSessionConnectIntent | undefined {
  const now = Date.now();
  return runOpenClawStateWriteTransaction(({ db }) => {
    ensureLocalSessionSchema(db);
    const store = kysely(db);
    const row = executeSqliteQuerySync(
      db,
      store
        .selectFrom("local_session_connect_intents")
        .selectAll()
        .where("setup_id", "=", params.setupId),
    ).rows[0];
    if (!row || row.activated_at_ms !== null || row.expires_at_ms <= now) {
      return undefined;
    }
    executeSqliteQuerySync(
      db,
      store
        .updateTable("local_session_connect_intents")
        .set({ activated_device_id: params.deviceId, activated_at_ms: now })
        .where("setup_id", "=", params.setupId),
    );
    const parsed: unknown = JSON.parse(row.source_ids_json);
    return {
      setupId: row.setup_id,
      ownerProfileId: row.owner_profile_id,
      ownerLabel: row.owner_label,
      agentId: row.agent_id,
      sourceIds: Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [],
      createdAtMs: row.created_at_ms,
      expiresAtMs: row.expires_at_ms,
    };
  }, options);
}
