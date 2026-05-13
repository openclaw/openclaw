import { createHash, randomUUID } from "node:crypto";
import type { Insertable, Selectable } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createAsyncLock } from "./async-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

// --- Types ---

type WebPushSubscription = {
  subscriptionId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAtMs: number;
  updatedAtMs: number;
};

export type WebPushRegistrationState = {
  subscriptionsByEndpointHash: Record<string, WebPushSubscription>;
};

export type VapidKeyPair = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

type WebPushSendResult = {
  ok: boolean;
  subscriptionId: string;
  statusCode?: number;
  error?: string;
};

// --- Constants ---

const WEB_PUSH_VAPID_KEY_ID = "default";
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 512;
const DEFAULT_VAPID_SUBJECT = "mailto:openclaw@localhost";

const withLock = createAsyncLock();

type WebPushRuntime = typeof import("web-push");
type WebPushRuntimeModule = WebPushRuntime & { default?: WebPushRuntime };

let webPushRuntimePromise: Promise<WebPushRuntime> | undefined;

type WebPushDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "web_push_subscriptions" | "web_push_vapid_keys"
>;

type WebPushSubscriptionRow = Selectable<WebPushDatabase["web_push_subscriptions"]>;
type WebPushSubscriptionInsert = Insertable<WebPushDatabase["web_push_subscriptions"]>;

type VapidKeyRow = {
  public_key: string;
  private_key: string;
  subject: string;
};

async function loadWebPushRuntime(): Promise<WebPushRuntime> {
  webPushRuntimePromise ??= import("web-push").then(
    (mod: WebPushRuntimeModule) => mod.default ?? mod,
  );
  return await webPushRuntimePromise;
}

// --- Helpers ---

function sqliteOptionsForBaseDir(baseDir: string | undefined): OpenClawStateDatabaseOptions {
  return baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {};
}

function openWebPushDatabase(baseDir?: string) {
  const database = openOpenClawStateDatabase(sqliteOptionsForBaseDir(baseDir));
  return { database, db: getNodeSqliteKysely<WebPushDatabase>(database.db) };
}

function sqliteIntegerToNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function hashEndpoint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 32);
}

function isValidEndpoint(endpoint: string): boolean {
  if (!endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) {
    return false;
  }
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidKey(key: string): boolean {
  return typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_LENGTH;
}

// --- State persistence ---

function rowToSubscription(row: WebPushSubscriptionRow): WebPushSubscription {
  return {
    subscriptionId: row.subscription_id,
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
    createdAtMs: sqliteIntegerToNumber(row.created_at_ms),
    updatedAtMs: sqliteIntegerToNumber(row.updated_at_ms),
  };
}

function subscriptionToRow(
  endpointHash: string,
  subscription: WebPushSubscription,
): WebPushSubscriptionInsert {
  return {
    endpoint_hash: endpointHash,
    subscription_id: subscription.subscriptionId,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    created_at_ms: subscription.createdAtMs,
    updated_at_ms: subscription.updatedAtMs,
  };
}

async function loadState(baseDir?: string): Promise<WebPushRegistrationState> {
  const { database, db } = openWebPushDatabase(baseDir);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("web_push_subscriptions")
      .select([
        "endpoint_hash",
        "subscription_id",
        "endpoint",
        "p256dh",
        "auth",
        "created_at_ms",
        "updated_at_ms",
      ])
      .orderBy("created_at_ms", "asc")
      .orderBy("subscription_id", "asc"),
  ).rows;
  const subscriptionsByEndpointHash: Record<string, WebPushSubscription> = {};
  for (const row of rows) {
    subscriptionsByEndpointHash[row.endpoint_hash] = rowToSubscription(row);
  }
  return { subscriptionsByEndpointHash };
}

async function persistState(state: WebPushRegistrationState, baseDir?: string): Promise<void> {
  const rows = Object.entries(state.subscriptionsByEndpointHash ?? {}).map(
    ([endpointHash, subscription]) => subscriptionToRow(endpointHash, subscription),
  );
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<WebPushDatabase>(database.db);
    if (rows.length === 0) {
      executeSqliteQuerySync(database.db, db.deleteFrom("web_push_subscriptions"));
      return;
    }
    const endpointHashes = rows.map((row) => row.endpoint_hash);
    const subscriptionIds = rows.map((row) => row.subscription_id);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("web_push_subscriptions").where("endpoint_hash", "not in", endpointHashes),
    );
    executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("web_push_subscriptions")
        .where("subscription_id", "in", subscriptionIds)
        .where("endpoint_hash", "not in", endpointHashes),
    );
    for (const row of rows) {
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("web_push_subscriptions")
          .values(row)
          .onConflict((conflict) =>
            conflict.column("endpoint_hash").doUpdateSet({
              subscription_id: (eb) => eb.ref("excluded.subscription_id"),
              endpoint: (eb) => eb.ref("excluded.endpoint"),
              p256dh: (eb) => eb.ref("excluded.p256dh"),
              auth: (eb) => eb.ref("excluded.auth"),
              created_at_ms: (eb) => eb.ref("excluded.created_at_ms"),
              updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
            }),
          ),
      );
    }
  }, sqliteOptionsForBaseDir(baseDir));
}

export async function writeWebPushRegistrationStateSnapshot(
  state: WebPushRegistrationState,
  baseDir?: string,
): Promise<void> {
  await persistState(state, baseDir);
}

export function writeWebPushVapidKeysSnapshot(keys: VapidKeyPair, baseDir?: string): void {
  persistVapidKeys(keys, baseDir);
}

// --- VAPID keys ---

export async function resolveVapidKeys(baseDir?: string): Promise<VapidKeyPair> {
  // Env vars take precedence — allows operators to share a stable VAPID
  // identity across multiple gateway instances.
  const envPublic = resolveVapidPublicKeyFromEnv();
  const envPrivate = resolveVapidPrivateKeyFromEnv();
  if (envPublic && envPrivate) {
    return {
      publicKey: envPublic,
      privateKey: envPrivate,
      subject: resolveVapidSubjectFromEnv(),
    };
  }

  // Fall back to persisted keys, generating on first use under a lock to
  // prevent concurrent bootstraps from writing different keypairs.
  return await withLock(async () => {
    const existing = readPersistedVapidKeys(baseDir);
    if (existing) {
      return {
        publicKey: existing.publicKey,
        privateKey: existing.privateKey,
        // Env var always wins so operators can change subject without touching persisted keys.
        subject: resolveVapidSubjectFromEnv(),
      };
    }

    const webPush = await loadWebPushRuntime();
    const keys = webPush.generateVAPIDKeys();
    const pair: VapidKeyPair = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: resolveVapidSubjectFromEnv(),
    };
    persistVapidKeys(pair, baseDir);
    return pair;
  });
}

function readPersistedVapidKeys(baseDir?: string): VapidKeyPair | null {
  const { database, db } = openWebPushDatabase(baseDir);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("web_push_vapid_keys")
      .select(["public_key", "private_key", "subject"])
      .where("key_id", "=", WEB_PUSH_VAPID_KEY_ID),
  ) as VapidKeyRow | undefined;
  if (!row?.public_key || !row.private_key) {
    return null;
  }
  return {
    publicKey: row.public_key,
    privateKey: row.private_key,
    subject: row.subject || DEFAULT_VAPID_SUBJECT,
  };
}

function persistVapidKeys(keys: VapidKeyPair, baseDir?: string): void {
  const updatedAtMs = Date.now();
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<WebPushDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("web_push_vapid_keys")
        .values({
          key_id: WEB_PUSH_VAPID_KEY_ID,
          public_key: keys.publicKey,
          private_key: keys.privateKey,
          subject: keys.subject || DEFAULT_VAPID_SUBJECT,
          updated_at_ms: updatedAtMs,
        })
        .onConflict((conflict) =>
          conflict.column("key_id").doUpdateSet({
            public_key: keys.publicKey,
            private_key: keys.privateKey,
            subject: keys.subject || DEFAULT_VAPID_SUBJECT,
            updated_at_ms: updatedAtMs,
          }),
        ),
    );
  }, sqliteOptionsForBaseDir(baseDir));
}

function resolveVapidSubjectFromEnv(): string {
  return process.env.OPENCLAW_VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT;
}

function resolveVapidPublicKeyFromEnv(): string | undefined {
  return process.env.OPENCLAW_VAPID_PUBLIC_KEY || undefined;
}

function resolveVapidPrivateKeyFromEnv(): string | undefined {
  return process.env.OPENCLAW_VAPID_PRIVATE_KEY || undefined;
}

// --- Subscription CRUD ---

type RegisterWebPushParams = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  baseDir?: string;
};

export async function registerWebPushSubscription(
  params: RegisterWebPushParams,
): Promise<WebPushSubscription> {
  const { endpoint, keys, baseDir } = params;

  if (!isValidEndpoint(endpoint)) {
    throw new Error("invalid push subscription endpoint: must be an HTTPS URL under 2048 chars");
  }
  if (!isValidKey(keys.p256dh) || !isValidKey(keys.auth)) {
    throw new Error("invalid push subscription keys: must be non-empty strings under 512 chars");
  }

  return await withLock(async () => {
    const hash = hashEndpoint(endpoint);
    const now = Date.now();
    const { database, db } = openWebPushDatabase(baseDir);
    const existingRow = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("web_push_subscriptions")
        .select(["subscription_id", "created_at_ms"])
        .where("endpoint_hash", "=", hash),
    );
    const subscription: WebPushSubscription = {
      subscriptionId: existingRow?.subscription_id ?? randomUUID(),
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      createdAtMs: existingRow?.created_at_ms
        ? sqliteIntegerToNumber(existingRow.created_at_ms)
        : now,
      updatedAtMs: now,
    };

    runOpenClawStateWriteTransaction((stateDatabase) => {
      const stateDb = getNodeSqliteKysely<WebPushDatabase>(stateDatabase.db);
      executeSqliteQuerySync(
        stateDatabase.db,
        stateDb
          .insertInto("web_push_subscriptions")
          .values({
            endpoint_hash: hash,
            subscription_id: subscription.subscriptionId,
            endpoint,
            p256dh: keys.p256dh,
            auth: keys.auth,
            created_at_ms: subscription.createdAtMs,
            updated_at_ms: now,
          })
          .onConflict((conflict) =>
            conflict.column("endpoint_hash").doUpdateSet({
              subscription_id: subscription.subscriptionId,
              endpoint,
              p256dh: keys.p256dh,
              auth: keys.auth,
              updated_at_ms: now,
            }),
          ),
      );
    }, sqliteOptionsForBaseDir(baseDir));
    return subscription;
  });
}

export async function loadWebPushSubscription(
  subscriptionId: string,
  baseDir?: string,
): Promise<WebPushSubscription | null> {
  const { database, db } = openWebPushDatabase(baseDir);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("web_push_subscriptions")
      .select([
        "endpoint_hash",
        "subscription_id",
        "endpoint",
        "p256dh",
        "auth",
        "created_at_ms",
        "updated_at_ms",
      ])
      .where("subscription_id", "=", subscriptionId),
  );
  return row ? rowToSubscription(row) : null;
}

export async function listWebPushSubscriptions(baseDir?: string): Promise<WebPushSubscription[]> {
  const state = await loadState(baseDir);
  return Object.values(state.subscriptionsByEndpointHash);
}

export async function clearWebPushSubscription(
  subscriptionId: string,
  baseDir?: string,
): Promise<boolean> {
  return await withLock(async () => {
    return runOpenClawStateWriteTransaction((database) => {
      const db = getNodeSqliteKysely<WebPushDatabase>(database.db);
      const result = executeSqliteQuerySync(
        database.db,
        db.deleteFrom("web_push_subscriptions").where("subscription_id", "=", subscriptionId),
      );
      return Number(result.numAffectedRows ?? 0) > 0;
    }, sqliteOptionsForBaseDir(baseDir));
  });
}

export async function clearWebPushSubscriptionByEndpoint(
  endpoint: string,
  baseDir?: string,
): Promise<boolean> {
  return await withLock(async () => {
    const hash = hashEndpoint(endpoint);
    return runOpenClawStateWriteTransaction((database) => {
      const db = getNodeSqliteKysely<WebPushDatabase>(database.db);
      const result = executeSqliteQuerySync(
        database.db,
        db.deleteFrom("web_push_subscriptions").where("endpoint_hash", "=", hash),
      );
      return Number(result.numAffectedRows ?? 0) > 0;
    }, sqliteOptionsForBaseDir(baseDir));
  });
}

// --- Sending ---

type WebPushPayload = {
  title: string;
  body?: string;
  tag?: string;
  url?: string;
};

function applyVapidDetails(webPush: WebPushRuntime, keys: VapidKeyPair): void {
  webPush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
}

export async function sendWebPushNotification(
  subscription: WebPushSubscription,
  payload: WebPushPayload,
  vapidKeys?: VapidKeyPair,
): Promise<WebPushSendResult> {
  const keys = vapidKeys ?? (await resolveVapidKeys());
  const webPush = await loadWebPushRuntime();
  applyVapidDetails(webPush, keys);

  return sendPreparedWebPushNotification(webPush, subscription, payload);
}

async function sendPreparedWebPushNotification(
  webPush: WebPushRuntime,
  subscription: WebPushSubscription,
  payload: WebPushPayload,
): Promise<WebPushSendResult> {
  const pushSubscription = {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
  };

  try {
    const result = await webPush.sendNotification(pushSubscription, JSON.stringify(payload));
    return {
      ok: true,
      subscriptionId: subscription.subscriptionId,
      statusCode: result.statusCode,
    };
  } catch (err: unknown) {
    const statusCode =
      typeof err === "object" && err !== null && "statusCode" in err
        ? (err as { statusCode: number }).statusCode
        : undefined;
    const message =
      typeof err === "object" && err !== null && "message" in err
        ? (err as { message: string }).message
        : "unknown error";
    return {
      ok: false,
      subscriptionId: subscription.subscriptionId,
      statusCode,
      error: message,
    };
  }
}

export async function broadcastWebPush(
  payload: WebPushPayload,
  baseDir?: string,
): Promise<WebPushSendResult[]> {
  const subscriptions = await listWebPushSubscriptions(baseDir);
  if (subscriptions.length === 0) {
    return [];
  }

  const vapidKeys = await resolveVapidKeys(baseDir);
  const webPush = await loadWebPushRuntime();

  // Set VAPID details once before fanning out concurrent sends.
  applyVapidDetails(webPush, vapidKeys);

  const results = await Promise.allSettled(
    subscriptions.map((sub) => sendPreparedWebPushNotification(webPush, sub, payload)),
  );

  const mapped = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          ok: false,
          subscriptionId: subscriptions[i].subscriptionId,
          error: r.reason instanceof Error ? r.reason.message : "unknown error",
        },
  );

  // Clean up expired subscriptions (HTTP 410 Gone or 404 Not Found) per Web Push spec.
  const expiredEndpoints = mapped
    .map((result, i) => ({ result, sub: subscriptions[i] }))
    .filter(({ result }) => !result.ok && (result.statusCode === 410 || result.statusCode === 404))
    .map(({ sub }) => sub.endpoint);

  if (expiredEndpoints.length > 0) {
    await Promise.allSettled(
      expiredEndpoints.map((endpoint) => clearWebPushSubscriptionByEndpoint(endpoint, baseDir)),
    );
  }

  return mapped;
}
