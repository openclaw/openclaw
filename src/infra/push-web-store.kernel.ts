// Canonical shared-SQLite store for Web Push subscriptions and VAPID identity.
import type { DatabaseSync } from "node:sqlite";
import type { WebPushDevicePreferences } from "../../packages/gateway-protocol/src/schema/push.js";
import { updateConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { ensureColumn } from "../state/openclaw-state-db-schema-helpers.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { createOpenClawStateSchemaEnsurer } from "../state/openclaw-state-feature-schema.js";
import { selectResolvedUserProfileMetadataById } from "../state/user-profiles-internal.js";
import { ensureUserProfilesSchema } from "../state/user-profiles-schema.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { normalizeWebPushDevicePreferences } from "./push-web-preferences.js";
import {
  WEB_PUSH_VAPID_STATE_KEY,
  WebPushSubscriptionBindingError,
  hashWebPushEndpoint,
  webPushSubscriptionFromRow,
  webPushSubscriptionToRow,
  boundWebPushSubscriptionFromRow,
  type WebPushDatabase,
  type WebPushSubscription,
  type BoundWebPushSubscription,
  type VapidKeyPair,
  type WebPushMutationProfiles,
  type WebPushMutationProfileFacts,
} from "./push-web-store.records.js";
import { requestSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

const WEB_PUSH_APPROVAL_RECOVERY_MAX_APPROVALS = 1_024;

const ensuredWebPushBindingDatabases = new WeakSet<DatabaseSync>();
const ensureWebPushApprovalDeliveryStateSchema = createOpenClawStateSchemaEnsurer({
  table: "web_push_approval_deliveries",
  endMarker: "  ON web_push_approval_deliveries(subscription_id, approval_id);\n",
  operationLabel: "web-push.approval-delivery.schema.ensure",
});

function webPushDatabaseOptions(database: OpenClawStateDatabase): OpenClawStateDatabaseOptions {
  return { database, path: database.path, env: getSqliteWorkerStateContext().environment };
}

/** Adds downgrade-safe binding columns before the first Web Push store operation. */
export function ensureWebPushSubscriptionBindingColumns(db: DatabaseSync): void {
  ensureColumn(db, "web_push_subscriptions", "device_id TEXT");
  ensureColumn(db, "web_push_subscriptions", "user_profile_id TEXT");
  ensureColumn(db, "web_push_subscriptions", "preferences_json TEXT");
}

function ensureWebPushSubscriptionBindingSchema(database: OpenClawStateDatabase): void {
  const options = webPushDatabaseOptions(database);
  if (ensuredWebPushBindingDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => ensureWebPushSubscriptionBindingColumns(db),
    options,
    { operationLabel: "web-push.subscription-binding.schema.ensure" },
  );
  ensuredWebPushBindingDatabases.add(database.db);
}

function ensureWebPushApprovalDeliverySchema(database: OpenClawStateDatabase): void {
  ensureWebPushApprovalDeliveryStateSchema(webPushDatabaseOptions(database));
}

function requestWebPushMutationAdmission(
  db: DatabaseSync,
  profiles: WebPushMutationProfiles | undefined,
  boundProfile: string | null | undefined,
): void {
  let facts: WebPushMutationProfileFacts | undefined;
  if (profiles) {
    const resolve = (reference: string | null | undefined) =>
      reference ? selectResolvedUserProfileMetadataById(db, reference)?.id : undefined;
    const original = resolve(profiles.original);
    const current = resolve(profiles.current);
    const bound = resolve(boundProfile);
    facts = {
      profileId: current ?? null,
      bindingCurrent:
        (!profiles.original || original !== undefined) &&
        (!profiles.current || current !== undefined) &&
        (!boundProfile || bound !== undefined) &&
        original === current &&
        bound === current,
    };
  }
  requestSqliteWorkerOperationAdmission({ stage: "transaction", facts });
}

export function findBoundWebPushSubscriptionByEndpointInDatabase(params: {
  endpoint: string;
  database: OpenClawStateDatabase;
}): BoundWebPushSubscription | null {
  ensureWebPushSubscriptionBindingSchema(params.database);
  const database = params.database;
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getNodeSqliteKysely<WebPushDatabase>(database.db)
      .selectFrom("web_push_subscriptions")
      .selectAll()
      .where("endpoint_hash", "=", hashWebPushEndpoint(params.endpoint))
      .where("endpoint", "=", params.endpoint),
  );
  return row ? boundWebPushSubscriptionFromRow(row) : null;
}

export function setWebPushSubscriptionPreferencesInDatabase(params: {
  endpoint: string;
  preferences: WebPushDevicePreferences;
  expectedDeviceId: string;
  expectedUserProfileId: string | null;
  requestProfiles?: WebPushMutationProfiles;
  assertCurrent?: () => void;
  database: OpenClawStateDatabase;
}): boolean {
  ensureWebPushSubscriptionBindingSchema(params.database);
  const options = webPushDatabaseOptions(params.database);
  if (params.requestProfiles?.original || params.requestProfiles?.current) {
    ensureUserProfilesSchema(options);
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    if (params.assertCurrent) {
      params.assertCurrent();
    } else {
      requestWebPushMutationAdmission(db, params.requestProfiles, params.expectedUserProfileId);
    }
    const result = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WebPushDatabase>(db)
        .updateTable("web_push_subscriptions")
        .set({
          preferences_json: JSON.stringify(normalizeWebPushDevicePreferences(params.preferences)),
          updated_at_ms: Date.now(),
        })
        .where("endpoint_hash", "=", hashWebPushEndpoint(params.endpoint))
        .where("endpoint", "=", params.endpoint)
        .where("device_id", "=", params.expectedDeviceId)
        .where(
          "user_profile_id",
          params.expectedUserProfileId === null ? "is" : "=",
          params.expectedUserProfileId,
        ),
    );
    return Number(result.numAffectedRows ?? 0) === 1;
  }, options);
}

export function listWebPushSubscriptionsInDatabase(
  database: OpenClawStateDatabase,
): WebPushSubscription[] {
  ensureWebPushSubscriptionBindingSchema(database);
  const stateDb = getNodeSqliteKysely<WebPushDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("web_push_subscriptions")
      .select(["subscription_id", "endpoint", "p256dh", "auth", "created_at_ms", "updated_at_ms"])
      .orderBy("created_at_ms", "asc")
      .orderBy("subscription_id", "asc"),
  ).rows.map(webPushSubscriptionFromRow);
}

export function hasBoundWebPushSubscriptionsInDatabase(database: OpenClawStateDatabase): boolean {
  ensureWebPushSubscriptionBindingSchema(database);
  const { db } = database;
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<WebPushDatabase>(db)
        .selectFrom("web_push_subscriptions")
        .select("subscription_id")
        .where("device_id", "is not", null)
        .where("device_id", "!=", "")
        .limit(1),
    ),
  );
}

/** Lists only subscriptions reconciled by an authenticated browser device. */
export function listBoundWebPushSubscriptionsInDatabase(
  database: OpenClawStateDatabase,
): BoundWebPushSubscription[] {
  ensureWebPushSubscriptionBindingSchema(database);
  const rows = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<WebPushDatabase>(database.db)
      .selectFrom("web_push_subscriptions")
      .selectAll()
      .where("device_id", "is not", null)
      .orderBy("created_at_ms", "asc")
      .orderBy("subscription_id", "asc"),
  ).rows;
  return rows.flatMap((row) => {
    const subscription = boundWebPushSubscriptionFromRow(row);
    return subscription ? [subscription] : [];
  });
}

/**
 * Record the subscriptions that may receive the request before network I/O.
 * Definite failures are removed after send; retaining the crash-ambiguous set
 * lets restart recovery replace any actionable notification that may exist.
 */
export function prepareWebPushApprovalDeliveriesInDatabase(params: {
  approvalId: string;
  subscriptions: readonly BoundWebPushSubscription[];
  preparedAtMs: number;
  database: OpenClawStateDatabase;
}): string[] {
  const subscriptionsById = new Map(
    params.subscriptions.map((subscription) => [subscription.subscriptionId, subscription]),
  );
  if (subscriptionsById.size === 0) {
    return [];
  }
  ensureWebPushApprovalDeliverySchema(params.database);
  const options = webPushDatabaseOptions(params.database);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<WebPushDatabase>(db);
    const approval = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("operator_approvals")
        .select("status")
        .where("approval_id", "=", params.approvalId),
    );
    if (approval?.status !== "pending") {
      return [];
    }
    const currentSubscriptions = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("web_push_subscriptions")
        .select(["subscription_id", "device_id", "user_profile_id"])
        .where("subscription_id", "in", [...subscriptionsById.keys()]),
    ).rows.flatMap((row) => {
      const prepared = subscriptionsById.get(row.subscription_id);
      return prepared?.deviceId === row.device_id && prepared.userProfileId === row.user_profile_id
        ? [prepared]
        : [];
    });
    if (currentSubscriptions.length === 0) {
      return [];
    }
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("web_push_approval_deliveries")
        .values(
          currentSubscriptions.map((subscription) => ({
            approval_id: params.approvalId,
            subscription_id: subscription.subscriptionId,
            device_id: subscription.deviceId,
            user_profile_id: subscription.userProfileId,
            prepared_at_ms: params.preparedAtMs,
          })),
        )
        .onConflict((conflict) =>
          conflict.columns(["approval_id", "subscription_id"]).doUpdateSet({
            device_id: (eb) => eb.ref("excluded.device_id"),
            user_profile_id: (eb) => eb.ref("excluded.user_profile_id"),
            prepared_at_ms: params.preparedAtMs,
          }),
        ),
    );
    return currentSubscriptions.map((subscription) => subscription.subscriptionId);
  }, options);
}

/** Load current targets and discard rows whose original browser ownership no longer matches. */
export function listWebPushApprovalDeliveryTargetsInDatabase(params: {
  approvalId: string;
  database: OpenClawStateDatabase;
}): BoundWebPushSubscription[] {
  ensureWebPushApprovalDeliverySchema(params.database);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<WebPushDatabase>(db);
    const rows = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("web_push_approval_deliveries")
        .innerJoin(
          "web_push_subscriptions",
          "web_push_subscriptions.subscription_id",
          "web_push_approval_deliveries.subscription_id",
        )
        .selectAll("web_push_subscriptions")
        .select([
          "web_push_approval_deliveries.device_id as delivery_device_id",
          "web_push_approval_deliveries.user_profile_id as delivery_user_profile_id",
        ])
        .where("web_push_approval_deliveries.approval_id", "=", params.approvalId)
        .orderBy("web_push_subscriptions.created_at_ms", "asc")
        .orderBy("web_push_subscriptions.subscription_id", "asc"),
    ).rows;
    const staleSubscriptionIds = new Set(
      rows
        .filter(
          (row) =>
            row.device_id !== row.delivery_device_id ||
            row.user_profile_id !== row.delivery_user_profile_id,
        )
        .map((row) => row.subscription_id),
    );
    if (staleSubscriptionIds.size > 0) {
      executeSqliteQuerySync(
        db,
        stateDb
          .deleteFrom("web_push_approval_deliveries")
          .where("approval_id", "=", params.approvalId)
          .where("subscription_id", "in", [...staleSubscriptionIds]),
      );
    }
    return rows.flatMap((row) => {
      if (staleSubscriptionIds.has(row.subscription_id)) {
        return [];
      }
      const subscription = boundWebPushSubscriptionFromRow(row);
      return subscription ? [subscription] : [];
    });
  }, webPushDatabaseOptions(params.database));
}

/** Remove only targets whose terminal replacement was accepted. */
export function deleteWebPushApprovalDeliveryTargetsInDatabase(params: {
  approvalId: string;
  subscriptionIds: readonly string[];
  database: OpenClawStateDatabase;
}): void {
  const subscriptionIds = [...new Set(params.subscriptionIds)];
  if (subscriptionIds.length === 0) {
    return;
  }
  ensureWebPushApprovalDeliverySchema(params.database);
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WebPushDatabase>(db)
        .deleteFrom("web_push_approval_deliveries")
        .where("approval_id", "=", params.approvalId)
        .where("subscription_id", "in", subscriptionIds),
    );
  }, webPushDatabaseOptions(params.database));
}

/** Page through a stable snapshot of terminal approvals that still need replacement. */
export function listTerminalWebPushApprovalDeliveryIdsInDatabase(params: {
  database: OpenClawStateDatabase;
  afterApprovalId?: string;
  throughApprovalId?: string;
}): {
  approvalIds: string[];
  nextAfterApprovalId: string | null;
  throughApprovalId: string | null;
} {
  ensureWebPushApprovalDeliverySchema(params.database);
  const database = params.database;
  const stateDb = getNodeSqliteKysely<WebPushDatabase>(database.db);
  const terminalApprovalQuery = () =>
    stateDb
      .selectFrom("web_push_approval_deliveries")
      .innerJoin(
        "operator_approvals",
        "operator_approvals.approval_id",
        "web_push_approval_deliveries.approval_id",
      )
      .select("web_push_approval_deliveries.approval_id")
      .distinct()
      .where("operator_approvals.status", "!=", "pending");
  const throughApprovalId =
    params.throughApprovalId ??
    executeSqliteQueryTakeFirstSync(
      database.db,
      terminalApprovalQuery().orderBy("web_push_approval_deliveries.approval_id", "desc").limit(1),
    )?.approval_id;
  if (!throughApprovalId) {
    return { approvalIds: [], nextAfterApprovalId: null, throughApprovalId: null };
  }
  let pageQuery = terminalApprovalQuery().where(
    "web_push_approval_deliveries.approval_id",
    "<=",
    throughApprovalId,
  );
  if (params.afterApprovalId) {
    pageQuery = pageQuery.where(
      "web_push_approval_deliveries.approval_id",
      ">",
      params.afterApprovalId,
    );
  }
  const rows = executeSqliteQuerySync(
    database.db,
    pageQuery
      .orderBy("web_push_approval_deliveries.approval_id", "asc")
      .limit(WEB_PUSH_APPROVAL_RECOVERY_MAX_APPROVALS + 1),
  ).rows;
  const approvalIds = rows
    .slice(0, WEB_PUSH_APPROVAL_RECOVERY_MAX_APPROVALS)
    .map((row) => row.approval_id);
  return {
    approvalIds,
    nextAfterApprovalId:
      rows.length > WEB_PUSH_APPROVAL_RECOVERY_MAX_APPROVALS ? (approvalIds.at(-1) ?? null) : null,
    throughApprovalId,
  };
}

/** Reread the endpoint row inside the write transaction before creating or updating it. */
export function upsertWebPushSubscriptionInDatabase(params: {
  endpointHash: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  binding?: { deviceId: string; userProfileId: string | null };
  candidateSubscriptionId: string;
  nowMs: number;
  requestProfiles?: WebPushMutationProfiles;
  assertCurrent?: () => void;
  database: OpenClawStateDatabase;
}): WebPushSubscription {
  ensureWebPushSubscriptionBindingSchema(params.database);
  if (params.requestProfiles?.original || params.requestProfiles?.current) {
    ensureUserProfilesSchema(webPushDatabaseOptions(params.database));
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    if (params.assertCurrent) {
      params.assertCurrent();
    } else {
      requestWebPushMutationAdmission(db, params.requestProfiles, params.binding?.userProfileId);
    }
    const stateDb = getNodeSqliteKysely<WebPushDatabase>(db);
    const existingRow = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("web_push_subscriptions")
        .selectAll()
        .where("endpoint_hash", "=", params.endpointHash),
    );
    if (existingRow && existingRow.endpoint !== params.endpoint) {
      throw new Error("web push endpoint hash collision");
    }
    const subscription: WebPushSubscription = {
      subscriptionId: existingRow?.subscription_id ?? params.candidateSubscriptionId,
      endpoint: params.endpoint,
      keys: { ...params.keys },
      createdAtMs: existingRow?.created_at_ms ?? params.nowMs,
      updatedAtMs: params.nowMs,
    };
    const row = webPushSubscriptionToRow({
      endpointHash: params.endpointHash,
      subscription,
      binding: params.binding,
    });
    // Device preferences belong to the exact browser/profile binding. Key refreshes
    // preserve them; ownership transfer resets them before the new owner can read.
    const bindingChanged = Boolean(
      existingRow &&
      (existingRow.device_id !== row.device_id ||
        existingRow.user_profile_id !== row.user_profile_id),
    );
    // Reconnect/profile handoff may rebind the same browser subscription, but
    // knowing its endpoint alone must not permit replacing its owner or keys.
    if (
      bindingChanged &&
      existingRow &&
      (existingRow.p256dh !== params.keys.p256dh || existingRow.auth !== params.keys.auth)
    ) {
      throw new WebPushSubscriptionBindingError(
        "existing browser subscription keys required; reconnect from the owning browser",
      );
    }
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("web_push_subscriptions")
        .values(row)
        .onConflict((conflict) =>
          conflict.column("endpoint_hash").doUpdateSet({
            subscription_id: row.subscription_id,
            endpoint: row.endpoint,
            p256dh: row.p256dh,
            auth: row.auth,
            device_id: row.device_id,
            user_profile_id: row.user_profile_id,
            preferences_json: bindingChanged ? null : (existingRow?.preferences_json ?? null),
            updated_at_ms: row.updated_at_ms,
          }),
        ),
    );
    return subscription;
  }, webPushDatabaseOptions(params.database));
}

export function deleteBoundWebPushSubscriptionInDatabase(params: {
  endpointHash: string;
  endpoint: string;
  expectedDeviceId: string;
  expectedUserProfileId: string | null;
  requestProfiles?: WebPushMutationProfiles;
  assertCurrent?: () => void;
  database: OpenClawStateDatabase;
}): boolean {
  ensureWebPushSubscriptionBindingSchema(params.database);
  if (params.requestProfiles?.original || params.requestProfiles?.current) {
    ensureUserProfilesSchema(webPushDatabaseOptions(params.database));
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    if (params.assertCurrent) {
      params.assertCurrent();
    } else {
      requestWebPushMutationAdmission(db, params.requestProfiles, params.expectedUserProfileId);
    }
    const result = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WebPushDatabase>(db)
        .deleteFrom("web_push_subscriptions")
        .where("endpoint_hash", "=", params.endpointHash)
        .where("endpoint", "=", params.endpoint)
        .where("device_id", "=", params.expectedDeviceId)
        .where(
          "user_profile_id",
          params.expectedUserProfileId === null ? "is" : "=",
          params.expectedUserProfileId,
        ),
    );
    return Number(result.numAffectedRows ?? 0) > 0;
  }, webPushDatabaseOptions(params.database));
}

/** Delete an expired send target only if no newer registration replaced it in flight. */
export function deleteWebPushSubscriptionIfCurrentInDatabase(params: {
  endpointHash: string;
  subscription: WebPushSubscription;
  database: OpenClawStateDatabase;
}): boolean {
  const subscription = params.subscription;
  ensureWebPushSubscriptionBindingSchema(params.database);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const result = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WebPushDatabase>(db)
        .deleteFrom("web_push_subscriptions")
        .where("endpoint_hash", "=", params.endpointHash)
        .where("subscription_id", "=", subscription.subscriptionId)
        .where("endpoint", "=", subscription.endpoint)
        .where("p256dh", "=", subscription.keys.p256dh)
        .where("auth", "=", subscription.keys.auth)
        .where("updated_at_ms", "=", subscription.updatedAtMs),
    );
    return Number(result.numAffectedRows ?? 0) > 0;
  }, webPushDatabaseOptions(params.database));
}

export function readPersistedVapidKeyPairInDatabase(
  options: OpenClawStateDatabaseOptions,
): VapidKeyPair | null {
  return readConfigMachineState<VapidKeyPair>(WEB_PUSH_VAPID_STATE_KEY, options) ?? null;
}

/** First committed keypair wins so concurrent gateway bootstraps share one signing identity. */
export function insertVapidKeyPairIfAbsentInDatabase(params: {
  candidate: VapidKeyPair;
  nowMs: number;
  database: OpenClawStateDatabase;
}): VapidKeyPair {
  return updateConfigMachineState<VapidKeyPair>(
    WEB_PUSH_VAPID_STATE_KEY,
    (current) => current ?? params.candidate,
    webPushDatabaseOptions(params.database),
  );
}
