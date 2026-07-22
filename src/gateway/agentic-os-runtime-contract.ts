import { randomUUID } from "node:crypto";
import { spawnSubagentDirect } from "../agents/subagent-spawn.js";

const CONTRACT_VERSION = "v1";

const ALLOW_LEASE_IDENTITY_FIELDS = [
  "client_lease_id",
  "idempotency_key",
  "run_id",
  "phase",
  "transition_id",
  "agent_id",
  "requester_agent_id",
] as const;

const ALLOW_LEASE_OWNER_FIELDS = [
  "client_lease_id",
  "run_id",
  "phase",
  "transition_id",
  "agent_id",
  "requester_agent_id",
] as const;

const SESSION_METADATA_FIELDS = [
  "run_id",
  "transition_id",
  "client_request_id",
  "idempotency_key",
  "phase",
  "agent_id",
  "task_digest",
] as const;

const FORBIDDEN_LEASE_CAMEL_ALIASES = [
  "clientLeaseId",
  "idempotencyKey",
  "runId",
  "transitionId",
  "agentId",
  "requesterAgentId",
  "ttlMs",
  "gatewayLeaseId",
] as const;

const FORBIDDEN_SPAWN_CAMEL_ALIASES = [
  "clientRequestId",
  "idempotencyKey",
  "gatewayLeaseId",
] as const;

const FORBIDDEN_SESSION_STATUS_CAMEL_ALIASES = ["sessionKey"] as const;

const FORBIDDEN_HISTORY_CAMEL_ALIASES = ["session_key"] as const;

const FORBIDDEN_ALL_CAMEL_ALIASES = [...FORBIDDEN_LEASE_CAMEL_ALIASES, "clientRequestId"] as const;

type RuntimeMetadata = {
  metadata_contract_version: "v1";
  normalized: Record<string, unknown>;
  raw_json: string;
};

type LeaseRecord = {
  gatewayLeaseId: string;
  fingerprint: string;
  acquireIdempotencyKey: string;
  clientLeaseId: string;
  owner: Record<(typeof ALLOW_LEASE_IDENTITY_FIELDS)[number], string>;
  spawnOwner: Record<(typeof ALLOW_LEASE_OWNER_FIELDS)[number], string>;
  acquireMetadata: RuntimeMetadata;
  created_at_ms: number;
  expires_at_ms: number;
  released_at_ms?: number;
};

type SessionRecord = {
  sessionKey: string;
  fingerprint: string;
  clientRequestId: string;
  idempotencyKey: string;
  gatewayLeaseId: string;
  metadata: RuntimeMetadata;
  task: string;
  taskName?: string;
  agentId: string;
  runId?: string;
  created_at_ms: number;
};

type ReleaseReplay = {
  fingerprint: string;
  response: Record<string, unknown>;
};

const leasesByGatewayId = new Map<string, LeaseRecord>();
const acquireByIdempotencyKey = new Map<string, LeaseRecord>();
const acquireByClientLeaseId = new Map<string, LeaseRecord>();
const releaseByIdempotencyKey = new Map<string, ReleaseReplay>();
const sessionsByKey = new Map<string, SessionRecord>();
const spawnByIdempotencyKey = new Map<string, SessionRecord>();
const spawnByClientRequestId = new Map<string, SessionRecord>();

class ContractInputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertNoForbiddenAliases(
  params: Record<string, unknown>,
  aliases: readonly string[] = FORBIDDEN_ALL_CAMEL_ALIASES,
) {
  const alias = aliases.find((key) => Object.hasOwn(params, key));
  if (alias) {
    throw new ContractInputError(`conflicting alias is not accepted: ${alias}`);
  }
}

function readString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ContractInputError(`missing required string: ${key}`);
  }
  return value;
}

function readPositiveInteger(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new ContractInputError(`missing required positive integer: ${key}`);
  }
  return value;
}

function pickStrings<const T extends readonly string[]>(
  params: Record<string, unknown>,
  fields: T,
): Record<T[number], string> {
  const picked = {} as Record<T[number], string>;
  for (const field of fields) {
    picked[field as T[number]] = readString(params, field);
  }
  return picked;
}

function metadataEnvelope(normalized: Record<string, unknown>): RuntimeMetadata {
  return {
    metadata_contract_version: CONTRACT_VERSION,
    normalized,
    raw_json: stableJson(normalized),
  };
}

function leaseResponse(record: LeaseRecord): Record<string, unknown> {
  const status = record.released_at_ms ? "released" : "active";
  return {
    status,
    gateway_lease_id: record.gatewayLeaseId,
    external_id: record.gatewayLeaseId,
    lease: {
      status,
      lease_id: record.gatewayLeaseId,
      gateway_lease_id: record.gatewayLeaseId,
      client_lease_id: record.clientLeaseId,
      expires_at_ms: record.expires_at_ms,
      released_at_ms: record.released_at_ms,
      metadata: record.acquireMetadata,
    },
    metadata: record.acquireMetadata,
  };
}

function releaseResponse(
  record: LeaseRecord,
  releaseMetadata: RuntimeMetadata,
): Record<string, unknown> {
  return {
    status: "released",
    released: true,
    gateway_lease_id: record.gatewayLeaseId,
    external_id: record.gatewayLeaseId,
    lease: {
      status: "released",
      lease_id: record.gatewayLeaseId,
      gateway_lease_id: record.gatewayLeaseId,
      client_lease_id: record.clientLeaseId,
      released_at_ms: record.released_at_ms,
      metadata: releaseMetadata,
    },
    metadata: releaseMetadata,
  };
}

function rejectConflict(message: string): never {
  throw new ContractInputError(message);
}

function pruneExpiredLeases(now = Date.now()) {
  for (const [gatewayLeaseId, record] of leasesByGatewayId.entries()) {
    if (!record.released_at_ms && record.expires_at_ms <= now) {
      record.released_at_ms = record.expires_at_ms;
      leasesByGatewayId.delete(gatewayLeaseId);
    }
  }
}

export function acquireAgenticOsAllowLease(
  params: Record<string, unknown>,
): Record<string, unknown> {
  assertNoForbiddenAliases(params, FORBIDDEN_LEASE_CAMEL_ALIASES);
  const owner = pickStrings(params, ALLOW_LEASE_IDENTITY_FIELDS);
  const spawnOwner = pickStrings(params, ALLOW_LEASE_OWNER_FIELDS);
  const ttlMs = readPositiveInteger(params, "ttl_ms");
  const fingerprint = stableJson({ ...owner, ttl_ms: ttlMs });
  const existingByIdempotency = acquireByIdempotencyKey.get(owner.idempotency_key);
  if (existingByIdempotency) {
    if (existingByIdempotency.fingerprint !== fingerprint) {
      return rejectConflict("conflicting allow lease acquire idempotency_key");
    }
    return leaseResponse(existingByIdempotency);
  }
  const existingByClientLease = acquireByClientLeaseId.get(owner.client_lease_id);
  if (existingByClientLease) {
    return rejectConflict("conflicting allow lease client_lease_id");
  }
  const gatewayLeaseId = `gateway-lease:${randomUUID()}`;
  const now = Date.now();
  const acquireMetadata = metadataEnvelope({
    ...owner,
    ttl_ms: ttlMs,
    gateway_lease_id: gatewayLeaseId,
  });
  const record: LeaseRecord = {
    gatewayLeaseId,
    fingerprint,
    acquireIdempotencyKey: owner.idempotency_key,
    clientLeaseId: owner.client_lease_id,
    owner,
    spawnOwner,
    acquireMetadata,
    created_at_ms: now,
    expires_at_ms: now + ttlMs,
  };
  leasesByGatewayId.set(gatewayLeaseId, record);
  acquireByIdempotencyKey.set(owner.idempotency_key, record);
  acquireByClientLeaseId.set(owner.client_lease_id, record);
  return leaseResponse(record);
}

export function listAgenticOsAllowLeases(): Record<string, unknown> {
  pruneExpiredLeases();
  const leases = [...leasesByGatewayId.values()]
    .filter((record) => !record.released_at_ms)
    .map((record) => leaseResponse(record));
  return { status: "ok", leases };
}

export function releaseAgenticOsAllowLease(
  params: Record<string, unknown>,
): Record<string, unknown> {
  assertNoForbiddenAliases(params, FORBIDDEN_LEASE_CAMEL_ALIASES);
  const owner = pickStrings(params, ALLOW_LEASE_OWNER_FIELDS);
  const releaseIdempotencyKey = readString(params, "idempotency_key");
  const gatewayLeaseId = readString(params, "gateway_lease_id");
  const normalized = {
    ...owner,
    idempotency_key: releaseIdempotencyKey,
    gateway_lease_id: gatewayLeaseId,
  };
  const fingerprint = stableJson(normalized);
  const replay = releaseByIdempotencyKey.get(releaseIdempotencyKey);
  if (replay) {
    if (replay.fingerprint !== fingerprint) {
      return rejectConflict("conflicting allow lease release idempotency_key");
    }
    return replay.response;
  }
  const record = acquireByClientLeaseId.get(owner.client_lease_id);
  if (!record || record.gatewayLeaseId !== gatewayLeaseId) {
    return rejectConflict("unknown allow lease owner or gateway_lease_id");
  }
  for (const field of ALLOW_LEASE_OWNER_FIELDS) {
    if (record.spawnOwner[field] !== owner[field]) {
      return rejectConflict(`allow lease owner mismatch: ${field}`);
    }
  }
  record.released_at_ms = record.released_at_ms ?? Date.now();
  leasesByGatewayId.delete(gatewayLeaseId);
  const response = releaseResponse(record, metadataEnvelope(normalized));
  releaseByIdempotencyKey.set(releaseIdempotencyKey, { fingerprint, response });
  return response;
}

function readSessionMetadata(params: Record<string, unknown>): Record<string, unknown> {
  const metadata = params.metadata;
  if (!isRecord(metadata)) {
    throw new ContractInputError("missing required object: metadata");
  }
  const keys = Object.keys(metadata).toSorted();
  const expected = [...SESSION_METADATA_FIELDS].toSorted();
  if (stableJson(keys) !== stableJson(expected)) {
    throw new ContractInputError("metadata must contain exactly the Agentic OS session v1 fields");
  }
  const normalized: Record<string, unknown> = {};
  for (const field of SESSION_METADATA_FIELDS) {
    normalized[field] = readString(metadata, field);
  }
  return normalized;
}

function sessionProjection(record: SessionRecord): Record<string, unknown> {
  return {
    key: record.sessionKey,
    session_key: record.sessionKey,
    sessionKey: record.sessionKey,
    external_id: record.sessionKey,
    spawn_request_session_key: record.sessionKey,
    gateway_lease_id: record.gatewayLeaseId,
    client_request_id: record.clientRequestId,
    idempotency_key: record.idempotencyKey,
    agent_id: record.agentId,
    task: record.task,
    taskName: record.taskName,
    runId: record.runId,
    created_at_ms: record.created_at_ms,
    metadata: record.metadata,
  };
}

function hasAgenticOsSpawnContract(params: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(params, "client_request_id") ||
    Object.hasOwn(params, "idempotency_key") ||
    Object.hasOwn(params, "gateway_lease_id") ||
    Object.hasOwn(params, "metadata")
  );
}

function requireLeaseAuthorizesSpawn(params: {
  lease: LeaseRecord;
  metadata: Record<string, unknown>;
  agentId: string;
}) {
  const { lease, metadata, agentId } = params;
  const expected: Record<(typeof ALLOW_LEASE_OWNER_FIELDS)[number], unknown> = {
    client_lease_id: lease.spawnOwner.client_lease_id,
    run_id: metadata.run_id,
    phase: metadata.phase,
    transition_id: metadata.transition_id,
    agent_id: agentId,
    requester_agent_id: lease.spawnOwner.requester_agent_id,
  };
  for (const field of ALLOW_LEASE_OWNER_FIELDS) {
    if (lease.spawnOwner[field] !== expected[field]) {
      rejectConflict(`gateway_lease_id owner does not authorize spawn: ${field}`);
    }
  }
}

function spawnResultSessionKey(result: Record<string, unknown>): string | undefined {
  for (const key of ["childSessionKey", "sessionKey", "session_key"]) {
    const value = result[key];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}

function spawnResultRunId(result: Record<string, unknown>): string | undefined {
  const value = result.runId;
  return typeof value === "string" && value ? value : undefined;
}

function spawnProjectionPayload(record: SessionRecord): Record<string, unknown> {
  const projection = sessionProjection(record);
  return {
    status: "accepted",
    ...projection,
    childSessionKey: record.sessionKey,
    runId: record.runId,
    session: projection,
  };
}

export async function spawnAgenticOsSession(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!hasAgenticOsSpawnContract(params)) {
    const legacy = await spawnSubagentDirect(
      {
        task: readString(params, "task"),
        taskName: typeof params.taskName === "string" ? params.taskName : undefined,
        label: typeof params.label === "string" ? params.label : undefined,
        agentId: typeof params.agentId === "string" ? params.agentId : undefined,
        model: typeof params.model === "string" ? params.model : undefined,
        thinking: typeof params.thinking === "string" ? params.thinking : undefined,
        cwd: typeof params.cwd === "string" ? params.cwd : undefined,
        thread: params.thread === true,
        mode: params.mode === "run" || params.mode === "session" ? params.mode : undefined,
        cleanup:
          params.cleanup === "delete" || params.cleanup === "keep" ? params.cleanup : undefined,
        sandbox: params.sandbox === "require" ? "require" : undefined,
        context:
          params.context === "fork" || params.context === "isolated" ? params.context : undefined,
        lightContext: params.lightContext === true,
      },
      {},
    );
    return legacy as Record<string, unknown>;
  }
  assertNoForbiddenAliases(params, FORBIDDEN_SPAWN_CAMEL_ALIASES);
  const clientRequestId = readString(params, "client_request_id");
  const idempotencyKey = readString(params, "idempotency_key");
  const gatewayLeaseId = readString(params, "gateway_lease_id");
  const task = readString(params, "task");
  const metadata = readSessionMetadata(params);
  const metadataClientRequestId = metadata.client_request_id;
  const metadataIdempotencyKey = metadata.idempotency_key;
  if (metadataClientRequestId !== clientRequestId || metadataIdempotencyKey !== idempotencyKey) {
    return rejectConflict("session metadata identity does not match spawn identity");
  }
  pruneExpiredLeases();
  const lease = leasesByGatewayId.get(gatewayLeaseId);
  if (!lease || lease.gatewayLeaseId !== gatewayLeaseId || lease.released_at_ms) {
    return rejectConflict("gateway_lease_id is not active");
  }
  const agentId =
    typeof params.agentId === "string" && params.agentId
      ? params.agentId
      : String(metadata.agent_id);
  if (agentId !== metadata.agent_id) {
    return rejectConflict("spawn agentId does not match session metadata agent_id");
  }
  requireLeaseAuthorizesSpawn({ lease, metadata, agentId });
  const taskName =
    typeof params.taskName === "string" && params.taskName ? params.taskName : undefined;
  const fingerprint = stableJson({
    client_request_id: clientRequestId,
    idempotency_key: idempotencyKey,
    gateway_lease_id: gatewayLeaseId,
    task,
    taskName,
    agentId,
    metadata,
  });
  const existingByIdempotency = spawnByIdempotencyKey.get(idempotencyKey);
  if (existingByIdempotency) {
    if (existingByIdempotency.fingerprint !== fingerprint) {
      return rejectConflict("conflicting sessions_spawn idempotency_key");
    }
    return spawnProjectionPayload(existingByIdempotency);
  }
  const existingByClientRequest = spawnByClientRequestId.get(clientRequestId);
  if (existingByClientRequest) {
    return rejectConflict("conflicting sessions_spawn client_request_id");
  }
  const spawnResult = (await spawnSubagentDirect(
    {
      task,
      taskName,
      agentId,
      mode: params.mode === "session" ? "session" : "run",
      cleanup:
        params.cleanup === "delete" || params.cleanup === "keep" ? params.cleanup : undefined,
      context:
        params.context === "fork" || params.context === "isolated" ? params.context : undefined,
      lightContext: params.lightContext === true,
      expectsCompletionMessage: false,
    },
    {
      agentSessionKey: `agent:${lease.spawnOwner.requester_agent_id}:main`,
      requesterAgentIdOverride: lease.spawnOwner.requester_agent_id,
    },
  )) as Record<string, unknown>;
  if (spawnResult.status !== "accepted") {
    return spawnResult;
  }
  const sessionKey = spawnResultSessionKey(spawnResult);
  if (!sessionKey) {
    return rejectConflict("sessions_spawn accepted without a child session identity");
  }
  const record: SessionRecord = {
    sessionKey,
    fingerprint,
    clientRequestId,
    idempotencyKey,
    gatewayLeaseId,
    metadata: metadataEnvelope(metadata),
    task,
    taskName,
    agentId,
    runId: spawnResultRunId(spawnResult),
    created_at_ms: Date.now(),
  };
  sessionsByKey.set(sessionKey, record);
  spawnByIdempotencyKey.set(idempotencyKey, record);
  spawnByClientRequestId.set(clientRequestId, record);
  return spawnProjectionPayload(record);
}

export function listAgenticOsSessions(): Record<string, unknown> {
  const sessions = [...sessionsByKey.values()].map((record) => sessionProjection(record));
  return { status: "ok", count: sessions.length, sessions };
}

export function statusAgenticOsSession(params: Record<string, unknown>): Record<string, unknown> {
  assertNoForbiddenAliases(params, FORBIDDEN_SESSION_STATUS_CAMEL_ALIASES);
  const sessionKey = readString(params, "session_key");
  const record = sessionsByKey.get(sessionKey);
  if (!record) {
    throw new ContractInputError("unknown session_key");
  }
  const projection = sessionProjection(record);
  return { status: "accepted", ...projection, session: projection };
}

export function historyAgenticOsSession(params: Record<string, unknown>): Record<string, unknown> {
  assertNoForbiddenAliases(params, FORBIDDEN_HISTORY_CAMEL_ALIASES);
  const sessionKey = readString(params, "sessionKey");
  const record = sessionsByKey.get(sessionKey);
  if (!record) {
    throw new ContractInputError("unknown sessionKey");
  }
  const projection = sessionProjection(record);
  return {
    status: "ok",
    ...projection,
    session: projection,
    messages: [
      {
        role: "system",
        content: "Agentic OS runtime contract v1 accepted session identity.",
        ...projection,
      },
    ],
  };
}

export { ContractInputError };
