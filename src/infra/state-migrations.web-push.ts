// Doctor-only import for the retired Web Push JSON stores.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  createWebPushVapidKeyPair,
  hashWebPushEndpoint,
  isValidWebPushEndpoint,
  isValidWebPushKey,
  webPushSubscriptionFromRow,
  webPushSubscriptionToRow,
  webPushSubscriptionsEqual,
  webPushVapidKeyPairToRow,
  DEFAULT_WEB_PUSH_VAPID_SUBJECT,
  WEB_PUSH_VAPID_KEY_ID,
  type VapidKeyPair,
  type WebPushDatabase,
  type WebPushSubscription,
} from "./push-web-store.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

const LEGACY_SUBSCRIPTIONS_MAX_BYTES = 4 * 1024 * 1024;
const LEGACY_VAPID_KEYS_MAX_BYTES = 64 * 1024;
const MIGRATION_LOCK_TIMEOUT_MS = 250;
const MIGRATION_LOCK_POLL_INTERVAL_MS = 25;
const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
const SUBSCRIPTION_STORE_KEYS = new Set(["subscriptionsByEndpointHash"]);
const SUBSCRIPTION_KEYS = new Set([
  "subscriptionId",
  "endpoint",
  "keys",
  "createdAtMs",
  "updatedAtMs",
]);
const PUSH_KEYS = new Set(["p256dh", "auth"]);
const VAPID_KEYS = new Set(["publicKey", "privateKey", "subject"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LegacySourceSnapshot = {
  sourcePath: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  raw: string;
  sha256: string;
  size: number;
};

type ParsedLegacyState = {
  subscriptions: Map<string, WebPushSubscription>;
  vapidKeys: VapidKeyPair | null;
  snapshots: LegacySourceSnapshot[];
};

function resolveLegacyWebPushPaths(stateDir: string): {
  subscriptionsPath: string;
  vapidKeysPath: string;
} {
  const pushDir = path.join(stateDir, "push");
  return {
    subscriptionsPath: path.join(pushDir, "web-push-subscriptions.json"),
    vapidKeysPath: path.join(pushDir, "vapid-keys.json"),
  };
}

function legacyPathMayExist(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function legacyPathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function sourceOrClaimMayExist(sourcePath: string): boolean {
  return (
    legacyPathMayExist(sourcePath) || legacyPathMayExist(`${sourcePath}${DOCTOR_CLAIM_SUFFIX}`)
  );
}

/** Detect retired Web Push state only when an explicit doctor flow opts in. */
export function detectLegacyWebPush(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["webPush"] {
  const paths = resolveLegacyWebPushPaths(params.stateDir);
  return {
    ...paths,
    hasLegacy:
      params.doctorOnlyStateMigrations === true &&
      (sourceOrClaimMayExist(paths.subscriptionsPath) ||
        sourceOrClaimMayExist(paths.vapidKeysPath)),
  };
}

function readLegacySourceSnapshot(sourcePath: string, maxBytes: number): LegacySourceSnapshot {
  const before = fs.lstatSync(sourcePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("legacy Web Push source is not a regular non-symlink file");
  }
  if (before.size > maxBytes) {
    throw new Error("legacy Web Push source exceeds its metadata size limit");
  }
  const raw = fs.readFileSync(sourcePath, "utf8");
  const after = fs.lstatSync(sourcePath);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error("legacy Web Push source changed while doctor was reading it");
  }
  return {
    sourcePath,
    dev: after.dev,
    ino: after.ino,
    mtimeMs: after.mtimeMs,
    raw,
    sha256: createHash("sha256").update(raw).digest("hex"),
    size: after.size,
  };
}

function sourceSnapshotsMatch(left: LegacySourceSnapshot, right: LegacySourceSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

function contentSnapshotsMatch(left: LegacySourceSnapshot, right: LegacySourceSnapshot): boolean {
  return left.sha256 === right.sha256 && left.size === right.size;
}

function maxBytesForSource(sourcePath: string, subscriptionsPath: string): number {
  return sourcePath === subscriptionsPath
    ? LEGACY_SUBSCRIPTIONS_MAX_BYTES
    : LEGACY_VAPID_KEYS_MAX_BYTES;
}

function recoverInterruptedClaim(sourcePath: string, maxBytes: number): void {
  const claimPath = `${sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
  if (!legacyPathExists(claimPath)) {
    return;
  }
  const claim = readLegacySourceSnapshot(claimPath, maxBytes);
  if (!legacyPathExists(sourcePath)) {
    fs.renameSync(claimPath, sourcePath);
    return;
  }
  const source = readLegacySourceSnapshot(sourcePath, maxBytes);
  if (!contentSnapshotsMatch(claim, source)) {
    throw new Error("interrupted Web Push doctor claim conflicts with its source");
  }
  fs.unlinkSync(claimPath);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
) {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(`${label} has unexpected field ${unexpected}`);
  }
}

function parseLegacySubscriptions(raw: string): Map<string, WebPushSubscription> {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.subscriptionsByEndpointHash)) {
    throw new Error("legacy Web Push subscriptions must be an object");
  }
  assertOnlyKeys(parsed, SUBSCRIPTION_STORE_KEYS, "legacy Web Push subscriptions store");

  const subscriptions = new Map<string, WebPushSubscription>();
  const subscriptionIds = new Set<string>();
  for (const [endpointHash, rawSubscription] of Object.entries(
    parsed.subscriptionsByEndpointHash,
  )) {
    if (!isRecord(rawSubscription) || !isRecord(rawSubscription.keys)) {
      throw new Error("legacy Web Push subscription is not an object");
    }
    assertOnlyKeys(rawSubscription, SUBSCRIPTION_KEYS, "legacy Web Push subscription");
    assertOnlyKeys(rawSubscription.keys, PUSH_KEYS, "legacy Web Push subscription keys");
    const { subscriptionId, endpoint, createdAtMs, updatedAtMs } = rawSubscription;
    const p256dh = rawSubscription.keys.p256dh;
    const auth = rawSubscription.keys.auth;
    if (
      typeof subscriptionId !== "string" ||
      !UUID_RE.test(subscriptionId) ||
      typeof endpoint !== "string" ||
      !isValidWebPushEndpoint(endpoint) ||
      hashWebPushEndpoint(endpoint) !== endpointHash ||
      !isValidWebPushKey(p256dh) ||
      !isValidWebPushKey(auth) ||
      typeof createdAtMs !== "number" ||
      !Number.isSafeInteger(createdAtMs) ||
      createdAtMs < 0 ||
      typeof updatedAtMs !== "number" ||
      !Number.isSafeInteger(updatedAtMs) ||
      updatedAtMs < createdAtMs
    ) {
      throw new Error("legacy Web Push subscription is invalid");
    }
    if (subscriptionIds.has(subscriptionId)) {
      throw new Error("legacy Web Push subscriptions contain a duplicate subscription id");
    }
    subscriptionIds.add(subscriptionId);
    subscriptions.set(endpointHash, {
      subscriptionId,
      endpoint,
      keys: { p256dh, auth },
      createdAtMs,
      updatedAtMs,
    });
  }
  return subscriptions;
}

function parseLegacyVapidKeys(raw: string): VapidKeyPair {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("legacy Web Push VAPID keys must be an object");
  }
  assertOnlyKeys(parsed, VAPID_KEYS, "legacy Web Push VAPID keys");
  const subject =
    parsed.subject === undefined || parsed.subject === ""
      ? process.env.OPENCLAW_VAPID_SUBJECT || DEFAULT_WEB_PUSH_VAPID_SUBJECT
      : parsed.subject;
  if (
    !isValidWebPushKey(parsed.publicKey) ||
    !isValidWebPushKey(parsed.privateKey) ||
    typeof subject !== "string" ||
    subject.length > 512
  ) {
    throw new Error("legacy Web Push VAPID keys are invalid");
  }
  return createWebPushVapidKeyPair(parsed.publicKey, parsed.privateKey, subject);
}

function readLegacyState(detected: LegacyStateDetection["webPush"]): ParsedLegacyState {
  recoverInterruptedClaim(detected.subscriptionsPath, LEGACY_SUBSCRIPTIONS_MAX_BYTES);
  recoverInterruptedClaim(detected.vapidKeysPath, LEGACY_VAPID_KEYS_MAX_BYTES);
  const snapshots: LegacySourceSnapshot[] = [];
  let subscriptions = new Map<string, WebPushSubscription>();
  let vapidKeys: VapidKeyPair | null = null;
  if (legacyPathExists(detected.subscriptionsPath)) {
    const snapshot = readLegacySourceSnapshot(
      detected.subscriptionsPath,
      LEGACY_SUBSCRIPTIONS_MAX_BYTES,
    );
    subscriptions = parseLegacySubscriptions(snapshot.raw);
    snapshots.push(snapshot);
  }
  if (legacyPathExists(detected.vapidKeysPath)) {
    const snapshot = readLegacySourceSnapshot(detected.vapidKeysPath, LEGACY_VAPID_KEYS_MAX_BYTES);
    vapidKeys = parseLegacyVapidKeys(snapshot.raw);
    snapshots.push(snapshot);
  }
  return { subscriptions, vapidKeys, snapshots };
}

function assertSourcesUnchanged(
  snapshots: readonly LegacySourceSnapshot[],
  subscriptionsPath: string,
): void {
  for (const snapshot of snapshots) {
    const current = readLegacySourceSnapshot(
      snapshot.sourcePath,
      maxBytesForSource(snapshot.sourcePath, subscriptionsPath),
    );
    if (!sourceSnapshotsMatch(current, snapshot)) {
      throw new Error("legacy Web Push source changed after doctor loaded it");
    }
  }
}

function mergedSubscription(params: {
  existing: WebPushSubscription;
  legacy: WebPushSubscription;
}): WebPushSubscription {
  const { existing, legacy } = params;
  if (existing.updatedAtMs === legacy.updatedAtMs) {
    if (!webPushSubscriptionsEqual(existing, legacy)) {
      throw new Error("Web Push subscription diverges at the same timestamp");
    }
    return existing;
  }
  const winner = existing.updatedAtMs > legacy.updatedAtMs ? existing : legacy;
  return { ...winner, createdAtMs: Math.min(existing.createdAtMs, legacy.createdAtMs) };
}

function findSubscriptionById(db: DatabaseSync, subscriptionId: string) {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<WebPushDatabase>(db)
      .selectFrom("web_push_subscriptions")
      .selectAll()
      .where("subscription_id", "=", subscriptionId),
  );
}

function writeSubscription(
  db: DatabaseSync,
  endpointHash: string,
  subscription: WebPushSubscription,
): void {
  const row = webPushSubscriptionToRow({ endpointHash, subscription });
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<WebPushDatabase>(db)
      .insertInto("web_push_subscriptions")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("endpoint_hash").doUpdateSet({
          subscription_id: row.subscription_id,
          endpoint: row.endpoint,
          p256dh: row.p256dh,
          auth: row.auth,
          created_at_ms: row.created_at_ms,
          updated_at_ms: row.updated_at_ms,
        }),
      ),
  );
}

function migrateIntoDatabase(params: {
  stateDir: string;
  legacy: ParsedLegacyState;
  nowMs: number;
}): { importedSubscriptions: number; importedVapidKeys: boolean } {
  let importedSubscriptions = 0;
  let importedVapidKeys = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const webPushDb = getNodeSqliteKysely<WebPushDatabase>(db);
      const expectedSubscriptions = new Map<string, WebPushSubscription>();
      for (const [endpointHash, legacySubscription] of params.legacy.subscriptions) {
        const existingRow = executeSqliteQueryTakeFirstSync(
          db,
          webPushDb
            .selectFrom("web_push_subscriptions")
            .selectAll()
            .where("endpoint_hash", "=", endpointHash),
        );
        if (existingRow && existingRow.endpoint !== legacySubscription.endpoint) {
          throw new Error("Web Push endpoint hash collision during legacy import");
        }
        const existing = existingRow ? webPushSubscriptionFromRow(existingRow) : null;
        const expected = existing
          ? mergedSubscription({ existing, legacy: legacySubscription })
          : legacySubscription;
        const conflictingIdRow = findSubscriptionById(db, expected.subscriptionId);
        if (conflictingIdRow && conflictingIdRow.endpoint_hash !== endpointHash) {
          throw new Error("Web Push subscription id conflicts with another endpoint");
        }
        if (!existing || !webPushSubscriptionsEqual(existing, expected)) {
          writeSubscription(db, endpointHash, expected);
          importedSubscriptions += 1;
        }
        expectedSubscriptions.set(endpointHash, expected);
      }

      let expectedVapidKeys: VapidKeyPair | null = null;
      if (params.legacy.vapidKeys) {
        const existingVapidRow = executeSqliteQueryTakeFirstSync(
          db,
          webPushDb
            .selectFrom("web_push_vapid_keys")
            .selectAll()
            .where("key_id", "=", WEB_PUSH_VAPID_KEY_ID),
        );
        if (existingVapidRow) {
          if (
            existingVapidRow.public_key !== params.legacy.vapidKeys.publicKey ||
            existingVapidRow.private_key !== params.legacy.vapidKeys.privateKey
          ) {
            throw new Error("legacy Web Push VAPID identity conflicts with SQLite");
          }
          expectedVapidKeys = createWebPushVapidKeyPair(
            existingVapidRow.public_key,
            existingVapidRow.private_key,
            existingVapidRow.subject,
          );
        } else {
          executeSqliteQuerySync(
            db,
            webPushDb
              .insertInto("web_push_vapid_keys")
              .values(
                webPushVapidKeyPairToRow({ keyPair: params.legacy.vapidKeys, nowMs: params.nowMs }),
              ),
          );
          expectedVapidKeys = params.legacy.vapidKeys;
          importedVapidKeys = true;
        }
      }

      for (const [endpointHash, expected] of expectedSubscriptions) {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          webPushDb
            .selectFrom("web_push_subscriptions")
            .selectAll()
            .where("endpoint_hash", "=", endpointHash),
        );
        if (!row || !webPushSubscriptionsEqual(webPushSubscriptionFromRow(row), expected)) {
          throw new Error("SQLite verification failed for a Web Push subscription");
        }
      }
      if (expectedVapidKeys) {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          webPushDb
            .selectFrom("web_push_vapid_keys")
            .selectAll()
            .where("key_id", "=", WEB_PUSH_VAPID_KEY_ID),
        );
        if (
          !row ||
          row.public_key !== expectedVapidKeys.publicKey ||
          row.private_key !== expectedVapidKeys.privateKey ||
          row.subject !== expectedVapidKeys.subject
        ) {
          throw new Error("SQLite verification failed for the Web Push VAPID identity");
        }
      }
    },
    { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
  );
  return { importedSubscriptions, importedVapidKeys };
}

function restoreClaims(claimed: readonly LegacySourceSnapshot[]): string[] {
  const errors: string[] = [];
  for (const snapshot of claimed.toReversed()) {
    const claimPath = `${snapshot.sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
    try {
      if (!legacyPathExists(claimPath)) {
        continue;
      }
      if (legacyPathExists(snapshot.sourcePath)) {
        errors.push(`source path already exists: ${snapshot.sourcePath}`);
        continue;
      }
      fs.renameSync(claimPath, snapshot.sourcePath);
    } catch (error) {
      errors.push(String(error));
    }
  }
  return errors;
}

function claimLegacySources(params: {
  snapshots: readonly LegacySourceSnapshot[];
  subscriptionsPath: string;
  beforeClaim?: () => void;
}): LegacySourceSnapshot[] {
  params.beforeClaim?.();
  const claimed: LegacySourceSnapshot[] = [];
  try {
    for (const snapshot of params.snapshots) {
      const claimPath = `${snapshot.sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
      fs.renameSync(snapshot.sourcePath, claimPath);
      claimed.push(snapshot);
      const current = readLegacySourceSnapshot(
        claimPath,
        maxBytesForSource(snapshot.sourcePath, params.subscriptionsPath),
      );
      if (!sourceSnapshotsMatch(current, snapshot)) {
        throw new Error("legacy Web Push source changed before doctor could claim it");
      }
    }
  } catch (error) {
    const restoreErrors = restoreClaims(claimed);
    throw new Error(
      `${String(error)}${restoreErrors.length > 0 ? `; restore failures: ${restoreErrors.join("; ")}` : ""}`,
      { cause: error },
    );
  }

  return claimed;
}

function removeClaimedSources(params: {
  claimed: readonly LegacySourceSnapshot[];
  removeSource?: (sourcePath: string) => void;
}): void {
  const recreatedSource = params.claimed.find((snapshot) => legacyPathExists(snapshot.sourcePath));
  if (recreatedSource) {
    throw new Error(
      `legacy Web Push source reappeared during import: ${recreatedSource.sourcePath}`,
    );
  }
  for (const snapshot of params.claimed) {
    (params.removeSource ?? fs.unlinkSync)(`${snapshot.sourcePath}${DOCTOR_CLAIM_SUFFIX}`);
  }
}

function migrateLegacyWebPushWithExclusiveStateOwnership(params: {
  detected: LegacyStateDetection["webPush"];
  stateDir: string;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => void;
}): MigrationMessages {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  if (!params.detected.hasLegacy) {
    return { changes, warnings };
  }

  let legacy: ParsedLegacyState;
  try {
    legacy = readLegacyState(params.detected);
  } catch (error) {
    warnings.push(`Failed reading legacy Web Push state: ${String(error)}`);
    return { changes, warnings };
  }

  let claimed: LegacySourceSnapshot[];
  try {
    params.beforeVerify?.();
    assertSourcesUnchanged(legacy.snapshots, params.detected.subscriptionsPath);
    // Claim both sources before the database transaction. A legacy writer can no longer
    // overwrite the retired paths after SQLite becomes canonical.
    claimed = claimLegacySources({
      snapshots: legacy.snapshots,
      subscriptionsPath: params.detected.subscriptionsPath,
      beforeClaim: params.beforeClaim,
    });
  } catch (error) {
    warnings.push(`Failed migrating legacy Web Push state: ${String(error)}`);
    return { changes, warnings };
  }

  let result: { importedSubscriptions: number; importedVapidKeys: boolean };
  try {
    result = migrateIntoDatabase({
      stateDir: params.stateDir,
      legacy,
      nowMs: Date.now(),
    });
  } catch (error) {
    const restoreErrors = restoreClaims(claimed);
    warnings.push(
      `Failed migrating legacy Web Push state: ${String(error)}${
        restoreErrors.length > 0 ? `; restore failures: ${restoreErrors.join("; ")}` : ""
      }`,
    );
    return { changes, warnings };
  }

  try {
    removeClaimedSources({
      claimed,
      removeSource: params.removeSource,
    });
  } catch (error) {
    warnings.push(`Web Push state is in SQLite, but legacy cleanup failed: ${String(error)}`);
    return { changes, warnings };
  }

  changes.push(
    `Migrated ${result.importedSubscriptions} Web Push subscription${result.importedSubscriptions === 1 ? "" : "s"} to SQLite.`,
  );
  if (result.importedVapidKeys) {
    changes.push("Migrated the Web Push VAPID identity to SQLite.");
  }
  notices.push("Removed retired Web Push JSON state after verified SQLite import.");
  return { changes, warnings, notices };
}

/** Import both retired stores while excluding old Gateways that can recreate them. */
export async function migrateLegacyWebPush(params: {
  detected: LegacyStateDetection["webPush"];
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => void;
}): Promise<MigrationMessages> {
  if (!params.detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }

  const env = { ...(params.env ?? process.env), OPENCLAW_STATE_DIR: params.stateDir };
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: MIGRATION_LOCK_POLL_INTERVAL_MS,
      role: "sqlite-maintenance",
      timeoutMs: MIGRATION_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    const detail =
      error instanceof GatewayLockError
        ? "the Gateway or another SQLite maintenance command owns this state directory"
        : String(error);
    return {
      changes: [],
      warnings: [
        `Failed migrating legacy Web Push state: ${detail}. Stop the Gateway and run \`openclaw doctor --fix\` again.`,
      ],
    };
  }
  if (!lock) {
    return {
      changes: [],
      warnings: ["Failed migrating legacy Web Push state: exclusive state ownership unavailable."],
    };
  }

  let result!: MigrationMessages;
  let releaseError: unknown;
  try {
    result = migrateLegacyWebPushWithExclusiveStateOwnership(params);
  } finally {
    try {
      await lock.release();
    } catch (error) {
      releaseError = error;
    }
  }
  if (releaseError) {
    result.warnings.push(`Web Push migration lock release failed: ${String(releaseError)}`);
  }
  return result;
}
