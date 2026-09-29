import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
// Canonical shared-SQLite store for APNs device and relay registrations.
import type { Selectable } from "kysely";
import { z } from "zod";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { clearApnsRegistrationFromDatabase } from "./push-apns-store-transaction.js";
import { ApnsRegistrationPairingChangedError } from "./push-apns-store.errors.js";
import { apnsRegistrationToRow } from "./push-apns-store.rows.js";
import type { ApnsEnvironment, ApnsRegistration } from "./push-apns-store.types.js";
import {
  normalizeApnsRelayBaseUrl,
  normalizePersistedApnsRelayBaseUrl,
} from "./push-apns.relay.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

export { ApnsRegistrationPairingChangedError } from "./push-apns-store.errors.js";
export type {
  ApnsEnvironment,
  ApnsRegistration,
  DirectApnsRegistration,
  RelayApnsRegistration,
} from "./push-apns-store.types.js";

type RegisterDirectApnsParams = {
  nodeId: string;
  transport?: "direct";
  token: string;
  topic: string;
  environment?: unknown;
  expectedPairingGeneration?: string;
  assertCurrent?: () => void;
  baseDir?: string;
};

type RegisterRelayApnsParams = {
  nodeId: string;
  transport: "relay";
  relayHandle: string;
  sendGrant: string;
  installationId: string;
  topic: string;
  environment?: unknown;
  distribution?: unknown;
  relayOrigin?: unknown;
  tokenDebugSuffix?: unknown;
  expectedPairingGeneration?: string;
  assertCurrent?: () => void;
  baseDir?: string;
};

type RegisterApnsParams = RegisterDirectApnsParams | RegisterRelayApnsParams;

type ApnsRegistrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "apns_registrations" | "apns_registration_tombstones"
>;
type ApnsRegistrationRow = Selectable<ApnsRegistrationDatabase["apns_registrations"]>;

const MAX_NODE_ID_LENGTH = 256;
const MAX_TOPIC_LENGTH = 255;
const MAX_APNS_TOKEN_HEX_LENGTH = 512;
const MAX_RELAY_IDENTIFIER_LENGTH = 256;
const MAX_SEND_GRANT_LENGTH = 1024;
const APNS_REGISTRATION_LOOKUP_CHUNK_SIZE = 500;

function apnsStateDatabaseOptions(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir
    ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }
    : { env: process.env };
}

export function normalizeApnsNodeId(value: string): string {
  return value.trim();
}

export function isValidApnsNodeId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_NODE_ID_LENGTH;
}

export function normalizeApnsToken(value: string): string {
  return normalizeLowercaseStringOrEmpty(value.trim().replace(/[<>\s]/g, ""));
}

function validateRelayIdentifier(
  value: string,
  fieldName: string,
  maxLength: number = MAX_RELAY_IDENTIFIER_LENGTH,
): string {
  if (!value) {
    throw new Error(`${fieldName} required`);
  }
  if (value.length > maxLength) {
    throw new Error(`${fieldName} too long`);
  }
  if (/[^\x21-\x7e]/.test(value)) {
    throw new Error(`${fieldName} invalid`);
  }
  return value;
}

function isValidRelayIdentifier(
  value: string,
  maxLength: number = MAX_RELAY_IDENTIFIER_LENGTH,
): boolean {
  return value.length > 0 && value.length <= maxLength && !/[^\x21-\x7e]/.test(value);
}

export function normalizeApnsTopic(value: string): string {
  return value.trim();
}

export function isValidApnsTopic(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TOPIC_LENGTH;
}

function normalizeTokenDebugSuffix(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(value.trim()).replace(/[^0-9a-z]/g, "");
  return normalized.length > 0 ? normalized.slice(-8) : undefined;
}

export function isLikelyApnsToken(value: string): boolean {
  return value.length <= MAX_APNS_TOKEN_HEX_LENGTH && /^[0-9a-f]{32,}$/i.test(value);
}

function normalizeDistribution(value: unknown): "official" | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeOptionalString(value)
    ? normalizeLowercaseStringOrEmpty(value)
    : undefined;
  return normalized === "official" ? "official" : null;
}

function normalizeRelayOrigin(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const normalized = normalizeApnsRelayBaseUrl(trimmed, env);
  return normalized.ok ? normalized.value : undefined;
}

function normalizePersistedRelayOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const normalized = normalizePersistedApnsRelayBaseUrl(trimmed);
  return normalized.ok ? normalized.value : undefined;
}

/** Normalizes the APNs environment string accepted by registration inputs. */
export function normalizeApnsEnvironment(value: unknown): ApnsEnvironment | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (normalized === "sandbox" || normalized === "production") {
    return normalized;
  }
  return null;
}

const apnsNodeIdSchema = z.string().transform(normalizeApnsNodeId).refine(isValidApnsNodeId);
const apnsTopicSchema = z.string().transform(normalizeApnsTopic).refine(isValidApnsTopic);
const apnsEnvironmentSchema = z
  .unknown()
  .transform(normalizeApnsEnvironment)
  .pipe(z.enum(["sandbox", "production"]));
const apnsUpdatedAtSchema = z
  .number()
  .refine(Number.isSafeInteger)
  .refine((value) => value >= 0);
const directApnsRegistrationSchema = z.object({
  nodeId: apnsNodeIdSchema,
  transport: z.string().transform(normalizeLowercaseStringOrEmpty).pipe(z.literal("direct")),
  token: z.string().transform(normalizeApnsToken).refine(isLikelyApnsToken),
  topic: apnsTopicSchema,
  environment: apnsEnvironmentSchema,
  updatedAtMs: apnsUpdatedAtSchema,
});
const relayApnsRegistrationSchema = z.object({
  nodeId: apnsNodeIdSchema,
  transport: z.string().transform(normalizeLowercaseStringOrEmpty).pipe(z.literal("relay")),
  relayHandle: z
    .string()
    .transform((value) => value.trim())
    .refine(isValidRelayIdentifier),
  sendGrant: z
    .string()
    .transform((value) => value.trim())
    .refine((value) => isValidRelayIdentifier(value, MAX_SEND_GRANT_LENGTH)),
  installationId: z
    .string()
    .transform((value) => value.trim())
    .refine(isValidRelayIdentifier),
  topic: apnsTopicSchema,
  environment: apnsEnvironmentSchema,
  distribution: z.unknown().transform(normalizeDistribution).pipe(z.literal("official")),
  updatedAtMs: apnsUpdatedAtSchema,
  relayOrigin: z.unknown().optional(),
  tokenDebugSuffix: z.unknown().optional().transform(normalizeTokenDebugSuffix),
});
const canonicalApnsRegistrationSchema = z.union([
  directApnsRegistrationSchema,
  relayApnsRegistrationSchema,
]);

function normalizeCanonicalApnsRegistrationWithRelayOrigin(
  record: unknown,
  normalizeOrigin: (value: unknown) => string | undefined,
): ApnsRegistration | null {
  const result = canonicalApnsRegistrationSchema.safeParse(record);
  if (!result.success) {
    return null;
  }
  if (result.data.transport === "direct") {
    return result.data;
  }
  const relayOrigin = normalizeOrigin(result.data.relayOrigin);
  const { relayOrigin: _rawRelayOrigin, ...registration } = result.data;
  return {
    ...registration,
    ...(relayOrigin ? { relayOrigin } : {}),
  };
}

/** Normalizes one canonical registration with an explicit transport discriminator. */
export function normalizeCanonicalApnsRegistration(
  record: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ApnsRegistration | null {
  return normalizeCanonicalApnsRegistrationWithRelayOrigin(record, (value) =>
    normalizeRelayOrigin(value, env),
  );
}

export function apnsRegistrationFromRow(row: ApnsRegistrationRow): ApnsRegistration {
  const { token } = row;
  const normalized = normalizeCanonicalApnsRegistrationWithRelayOrigin(
    {
      nodeId: row.node_id,
      transport: row.transport,
      token,
      relayHandle: row.relay_handle ?? undefined,
      sendGrant: row.send_grant ?? undefined,
      installationId: row.installation_id ?? undefined,
      relayOrigin: row.relay_origin ?? undefined,
      topic: row.topic,
      environment: row.environment,
      distribution: row.distribution ?? undefined,
      tokenDebugSuffix: row.token_debug_suffix ?? undefined,
      updatedAtMs: row.updated_at_ms,
    },
    normalizePersistedRelayOrigin,
  );
  if (!normalized) {
    throw new Error("invalid APNs registration row");
  }
  const canonical = apnsRegistrationToRow(normalized);
  if (
    canonical.node_id !== row.node_id ||
    canonical.transport !== row.transport ||
    canonical.token !== row.token ||
    canonical.relay_handle !== row.relay_handle ||
    canonical.send_grant !== row.send_grant ||
    canonical.installation_id !== row.installation_id ||
    canonical.relay_origin !== row.relay_origin ||
    canonical.topic !== row.topic ||
    canonical.environment !== row.environment ||
    canonical.distribution !== row.distribution ||
    canonical.token_debug_suffix !== row.token_debug_suffix ||
    canonical.updated_at_ms !== row.updated_at_ms
  ) {
    throw new Error("non-canonical APNs registration row");
  }
  return normalized;
}

function apnsRegistrationsEqual(left: ApnsRegistration, right: ApnsRegistration): boolean {
  if (
    left.nodeId !== right.nodeId ||
    left.transport !== right.transport ||
    left.topic !== right.topic ||
    left.environment !== right.environment ||
    left.updatedAtMs !== right.updatedAtMs
  ) {
    return false;
  }
  if (left.transport === "direct" && right.transport === "direct") {
    return left.token === right.token;
  }
  return (
    left.transport === "relay" &&
    right.transport === "relay" &&
    left.relayHandle === right.relayHandle &&
    left.sendGrant === right.sendGrant &&
    left.installationId === right.installationId &&
    left.distribution === right.distribution &&
    left.relayOrigin === right.relayOrigin &&
    left.tokenDebugSuffix === right.tokenDebugSuffix
  );
}

/** Persists a validated direct or relay APNs registration for one node id. */
export async function registerApnsRegistration(
  params: RegisterApnsParams,
): Promise<ApnsRegistration> {
  const nodeId = normalizeApnsNodeId(params.nodeId);
  const topic = normalizeApnsTopic(params.topic);
  if (!isValidApnsNodeId(nodeId)) {
    throw new Error("nodeId required");
  }
  if (!isValidApnsTopic(topic)) {
    throw new Error("topic required");
  }

  let candidate: ApnsRegistration;
  if (params.transport === "relay") {
    const relayHandle = validateRelayIdentifier(params.relayHandle.trim(), "relayHandle");
    const sendGrant = validateRelayIdentifier(
      params.sendGrant.trim(),
      "sendGrant",
      MAX_SEND_GRANT_LENGTH,
    );
    const installationId = validateRelayIdentifier(params.installationId.trim(), "installationId");
    const environment = normalizeApnsEnvironment(params.environment);
    const distribution = normalizeDistribution(params.distribution);
    const relayOrigin = normalizeRelayOrigin(params.relayOrigin);
    if (!environment) {
      throw new Error("relay registrations must use valid APNs environment");
    }
    if (distribution !== "official") {
      throw new Error("relay registrations must use official distribution");
    }
    candidate = {
      nodeId,
      transport: "relay",
      relayHandle,
      sendGrant,
      installationId,
      topic,
      environment,
      distribution,
      updatedAtMs: 0,
      ...(relayOrigin ? { relayOrigin } : {}),
      tokenDebugSuffix: normalizeTokenDebugSuffix(params.tokenDebugSuffix),
    };
  } else {
    const token = normalizeApnsToken(params.token);
    const environment = normalizeApnsEnvironment(params.environment) ?? "sandbox";
    if (!isLikelyApnsToken(token)) {
      throw new Error("invalid APNs token");
    }
    candidate = {
      nodeId,
      transport: "direct",
      token,
      topic,
      environment,
      updatedAtMs: 0,
    };
  }

  const context = captureOpenClawStateWorkerContext(apnsStateDatabaseOptions(params.baseDir));
  const nowMs = Date.now();
  const expectedPairingGeneration = params.expectedPairingGeneration;
  const assertCurrent = params.assertCurrent;
  const { runOpenClawStateWorkerOperation } =
    await import("../state/openclaw-state-worker-store.js");
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "apns.registration.register",
        input: { candidate, expectedPairingGeneration, nowMs },
      }),
    {
      assertCurrent,
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction" && request.stage !== "commit") {
            throw new Error("APNs registration requires transaction admission");
          }
          context.admission.assertCurrent();
          assertCurrent?.();
          grant();
        }),
      }),
    },
  );
  if (result.status === "pairing-changed") {
    throw new ApnsRegistrationPairingChangedError();
  }
  return result.registration;
}

/** Loads one normalized APNs registration by node id. */
export async function loadApnsRegistration(
  nodeId: string,
  baseDir?: string,
): Promise<ApnsRegistration | null> {
  const normalizedNodeId = normalizeApnsNodeId(nodeId);
  if (!normalizedNodeId) {
    return null;
  }
  const context = captureOpenClawStateWorkerContext(apnsStateDatabaseOptions(baseDir));
  const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
  return executeOpenClawStateWorker(context, {
    type: "apns.registration.read",
    input: normalizedNodeId,
  });
}

/** Read and decode one registration through the caller's canonical connection. */
export function readApnsRegistrationFromDatabase(
  db: OpenClawStateDatabase["db"],
  normalizedNodeId: string,
): ApnsRegistration | null {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<ApnsRegistrationDatabase>(db)
      .selectFrom("apns_registrations")
      .selectAll()
      .where("node_id", "=", normalizedNodeId),
  );
  return row ? apnsRegistrationFromRow(row) : null;
}

/** Loads normalized APNs registrations for the requested node ids, preserving request order. */
export async function loadApnsRegistrations(
  nodeIds: readonly string[],
  baseDir?: string,
): Promise<Array<{ nodeId: string; registration: ApnsRegistration }>> {
  const normalizedByInput = nodeIds.map((nodeId) => ({
    nodeId,
    normalizedNodeId: normalizeApnsNodeId(nodeId),
  }));
  const uniqueNodeIds = [
    ...new Set(
      normalizedByInput
        .map((entry) => entry.normalizedNodeId)
        .filter((nodeId) => isValidApnsNodeId(nodeId)),
    ),
  ];
  if (uniqueNodeIds.length === 0) {
    return [];
  }
  const context = captureOpenClawStateWorkerContext(apnsStateDatabaseOptions(baseDir));
  const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
  const registrations = await executeOpenClawStateWorker(context, {
    type: "apns.registrations.read",
    input: uniqueNodeIds,
  });
  return normalizedByInput.flatMap(({ nodeId, normalizedNodeId }) => {
    const registration = registrations.get(normalizedNodeId);
    return registration ? [{ nodeId, registration }] : [];
  });
}

/** Decode each bounded query before advancing to the next requested chunk. */
export function readApnsRegistrationsFromDatabase(
  db: OpenClawStateDatabase["db"],
  uniqueNodeIds: readonly string[],
): Map<string, ApnsRegistration> {
  const registrations = new Map<string, ApnsRegistration>();
  const stateDb = getNodeSqliteKysely<ApnsRegistrationDatabase>(db);
  for (
    let offset = 0;
    offset < uniqueNodeIds.length;
    offset += APNS_REGISTRATION_LOOKUP_CHUNK_SIZE
  ) {
    const rows = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("apns_registrations")
        .selectAll()
        .where(
          "node_id",
          "in",
          uniqueNodeIds.slice(offset, offset + APNS_REGISTRATION_LOOKUP_CHUNK_SIZE),
        ),
    ).rows;
    for (const row of rows) {
      registrations.set(row.node_id, apnsRegistrationFromRow(row));
    }
  }
  return registrations;
}

/** Clears a registration only if storage still contains the caller's observed value. */
export async function clearApnsRegistrationIfCurrent(params: {
  nodeId: string;
  registration: ApnsRegistration;
  baseDir?: string;
}): Promise<boolean> {
  const normalizedNodeId = normalizeApnsNodeId(params.nodeId);
  if (!normalizedNodeId) {
    return false;
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ApnsRegistrationDatabase>(db);
    const currentRow = executeSqliteQueryTakeFirstSync(
      db,
      stateDb.selectFrom("apns_registrations").selectAll().where("node_id", "=", normalizedNodeId),
    );
    if (
      !currentRow ||
      !apnsRegistrationsEqual(apnsRegistrationFromRow(currentRow), params.registration)
    ) {
      return false;
    }
    return clearApnsRegistrationFromDatabase(db, normalizedNodeId);
  }, apnsStateDatabaseOptions(params.baseDir));
}
