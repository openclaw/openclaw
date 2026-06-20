import { normalizeAgentId } from "../../routing/session-key.js";
import { qualifyPostgresSessionTable } from "./postgres-schema.js";
import {
  normalizeSessionStoreListOptions,
  normalizeSessionTranscriptChunkListOptions,
  normalizeSessionTurnListOptions,
  type SessionStoreAdapter,
  type SessionStoreListOptions,
  type SessionStoreListResult,
  type SessionStoreMutationOptions,
  type SessionStoreRecord,
  type SessionTranscriptChunk,
  type SessionTranscriptChunkListOptions,
  type SessionTranscriptChunkListResult,
  type SessionTranscriptChunkPayload,
  type SessionTurnListOptions,
  type SessionTurnListResult,
  type SessionTurnRecord,
} from "./storage-adapter.js";
import type { SessionEntry } from "./types.js";

export type PostgresSessionStoreQueryRow = Record<string, unknown>;

export type PostgresSessionStoreQueryResult<
  TRow extends PostgresSessionStoreQueryRow = PostgresSessionStoreQueryRow,
> = {
  rows: TRow[];
  rowCount?: number | null;
};

export type PostgresSessionStoreQueryClient = {
  query<TRow extends PostgresSessionStoreQueryRow = PostgresSessionStoreQueryRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<PostgresSessionStoreQueryResult<TRow>>;
};

export type PostgresSessionStoreAdapterOptions = {
  tenantId: string;
  gatewayId: string;
  schema?: string;
  defaultAgentId?: string;
  resolveAgentId?: (params: {
    storePath: string;
    sessionKey: string;
    entry: SessionEntry;
  }) => string | undefined;
};

type SessionRow = PostgresSessionStoreQueryRow & {
  session_key?: unknown;
  entry_json?: unknown;
  total_count?: unknown;
};

type TranscriptChunkRow = PostgresSessionStoreQueryRow & {
  chunk_seq?: unknown;
  transcript_path?: unknown;
  content_sha256?: unknown;
  bytes?: unknown;
  chunk_json?: unknown;
  total_count?: unknown;
};

type SessionTurnRow = PostgresSessionStoreQueryRow & {
  turn_seq?: unknown;
  role?: unknown;
  model_provider?: unknown;
  model?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  started_at?: unknown;
  ended_at?: unknown;
  metadata_json?: unknown;
  total_count?: unknown;
};

type TotalCountRow = PostgresSessionStoreQueryRow & {
  total_count?: unknown;
};

const DEFAULT_SCHEMA = "openclaw";
const DEFAULT_AGENT_ID = "main";

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function decodeSessionEntry(value: unknown): SessionEntry {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SessionEntry;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as SessionEntry;
  }
  throw new Error("Invalid PostgreSQL session entry payload");
}

function decodeSessionKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Invalid PostgreSQL session key payload");
  }
  return value;
}

function decodeInteger(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  throw new Error(`Invalid PostgreSQL ${label} payload`);
}

function decodeTotalCount(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return fallback;
}

async function resolvePagedTotalCount(params: {
  client: PostgresSessionStoreQueryClient;
  rows: readonly PostgresSessionStoreQueryRow[];
  decodedLength: number;
  offset: number;
  countSql: string;
  countValues: readonly unknown[];
}): Promise<number> {
  const firstRow = params.rows[0];
  if (firstRow) {
    return decodeTotalCount(firstRow.total_count, params.decodedLength);
  }
  if (params.offset <= 0) {
    return params.decodedLength;
  }
  const countResult = await params.client.query<TotalCountRow>(params.countSql, params.countValues);
  return decodeTotalCount(countResult.rows[0]?.total_count, params.decodedLength);
}

function decodeTranscriptChunkPayload(value: unknown): SessionTranscriptChunkPayload {
  const parsed =
    typeof value === "string"
      ? (JSON.parse(value) as unknown)
      : value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    (parsed as { version?: unknown }).version === 1 &&
    typeof (parsed as { startLine?: unknown }).startLine === "number" &&
    typeof (parsed as { endLine?: unknown }).endLine === "number" &&
    Array.isArray((parsed as { lines?: unknown }).lines)
  ) {
    return parsed as SessionTranscriptChunkPayload;
  }
  throw new Error("Invalid PostgreSQL transcript chunk payload");
}

function decodeTranscriptChunk(row: TranscriptChunkRow): SessionTranscriptChunk {
  const transcriptPath =
    typeof row.transcript_path === "string" && row.transcript_path
      ? row.transcript_path
      : undefined;
  const contentSha256 = typeof row.content_sha256 === "string" ? row.content_sha256 : "";
  if (!contentSha256) {
    throw new Error("Invalid PostgreSQL transcript chunk hash payload");
  }
  return {
    chunkSeq: decodeInteger(row.chunk_seq, "transcript chunk sequence"),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    contentSha256,
    bytes: decodeInteger(row.bytes, "transcript chunk byte count"),
    chunkJson: decodeTranscriptChunkPayload(row.chunk_json),
  };
}

function decodeOptionalInteger(value: unknown, label: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  return decodeInteger(value, label);
}

function decodeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function decodeMetadataJson(value: unknown): Record<string, unknown> {
  const parsed =
    typeof value === "string"
      ? (JSON.parse(value) as unknown)
      : value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

function decodeSessionTurn(row: SessionTurnRow): SessionTurnRecord {
  const role = decodeOptionalString(row.role);
  if (!role) {
    throw new Error("Invalid PostgreSQL session turn role payload");
  }
  return {
    turnSeq: decodeInteger(row.turn_seq, "session turn sequence"),
    role,
    ...(decodeOptionalString(row.model_provider) !== undefined
      ? { modelProvider: decodeOptionalString(row.model_provider) }
      : {}),
    ...(decodeOptionalString(row.model) !== undefined
      ? { model: decodeOptionalString(row.model) }
      : {}),
    ...(decodeOptionalInteger(row.input_tokens, "session turn input token count") !== undefined
      ? { inputTokens: decodeOptionalInteger(row.input_tokens, "session turn input token count") }
      : {}),
    ...(decodeOptionalInteger(row.output_tokens, "session turn output token count") !== undefined
      ? {
          outputTokens: decodeOptionalInteger(row.output_tokens, "session turn output token count"),
        }
      : {}),
    ...(decodeOptionalString(row.started_at) !== undefined
      ? { startedAt: decodeOptionalString(row.started_at) }
      : {}),
    ...(decodeOptionalString(row.ended_at) !== undefined
      ? { endedAt: decodeOptionalString(row.ended_at) }
      : {}),
    metadataJson: decodeMetadataJson(row.metadata_json),
  };
}

function updatedAtForEntry(entry: SessionEntry): number {
  return typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
    ? Math.floor(entry.updatedAt)
    : 0;
}

function sessionIdForEntry(entry: SessionEntry): string | null {
  return typeof entry.sessionId === "string" && entry.sessionId.trim() ? entry.sessionId : null;
}

function entryToJsonbParam(entry: SessionEntry): string {
  return JSON.stringify(entry);
}

function escapePostgresLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function buildWhereClause(params: {
  tenantId: string;
  gatewayId: string;
  storePath: string;
  values: unknown[];
  keys?: readonly string[];
  excludeKeys?: readonly string[];
  label?: string;
  spawnedBy?: string;
  search?: string;
  updatedAfter?: number;
}): string {
  const clauses = [
    `tenant_id = $${params.values.push(params.tenantId)}`,
    `gateway_id = $${params.values.push(params.gatewayId)}`,
    `store_path = $${params.values.push(params.storePath)}`,
    "deleted_at IS NULL",
  ];
  if (params.keys && params.keys.length > 0) {
    clauses.push(`session_key = ANY($${params.values.push([...params.keys])}::text[])`);
  }
  if (params.excludeKeys && params.excludeKeys.length > 0) {
    clauses.push(
      `NOT (session_key = ANY($${params.values.push([...params.excludeKeys])}::text[]))`,
    );
  }
  if (params.label) {
    clauses.push(`entry_json->>'label' = $${params.values.push(params.label)}`);
  }
  if (params.spawnedBy) {
    const index = params.values.push(params.spawnedBy);
    clauses.push(
      `(entry_json->>'spawnedBy' = $${index} OR entry_json->>'parentSessionKey' = $${index})`,
    );
  }
  if (params.search) {
    const index = params.values.push(`%${escapePostgresLikePattern(params.search.toLowerCase())}%`);
    clauses.push(
      `lower(concat_ws(' ', session_key, entry_json->>'displayName', entry_json->>'label', entry_json->>'subject', entry_json->>'sessionId', entry_json->>'modelProvider', entry_json->>'model', CASE WHEN entry_json ? 'modelProvider' AND entry_json ? 'model' THEN concat(entry_json->>'modelProvider', '/', entry_json->>'model') ELSE NULL END)) LIKE $${index} ESCAPE '\\'`,
    );
  }
  if (params.updatedAfter !== undefined) {
    clauses.push(`updated_at_ms >= $${params.values.push(params.updatedAfter)}`);
  }
  return clauses.join(" AND ");
}

function orderBySql(orderBy: NonNullable<SessionStoreListOptions["orderBy"]>): string {
  if (orderBy === "updatedAt_asc") {
    return "updated_at_ms ASC, session_key ASC";
  }
  if (orderBy === "key_asc") {
    return "session_key ASC";
  }
  return "updated_at_ms DESC, session_key ASC";
}

function chunkOrderBySql(
  orderBy: NonNullable<SessionTranscriptChunkListOptions["orderBy"]>,
): string {
  return orderBy === "chunkSeq_desc" ? "chunk_seq DESC" : "chunk_seq ASC";
}

function turnOrderBySql(orderBy: NonNullable<SessionTurnListOptions["orderBy"]>): string {
  return orderBy === "turnSeq_desc" ? "turn_seq DESC" : "turn_seq ASC";
}

function normalizeStoreEntries(store: SessionStoreRecord): Array<[string, SessionEntry]> {
  return Object.entries(store).toSorted(([left], [right]) => left.localeCompare(right));
}

export function createPostgresSessionStoreAdapter(
  client: PostgresSessionStoreQueryClient,
  options: PostgresSessionStoreAdapterOptions,
): SessionStoreAdapter {
  const tenantId = requireNonEmpty(options.tenantId, "tenantId");
  const gatewayId = requireNonEmpty(options.gatewayId, "gatewayId");
  const schema = options.schema ?? DEFAULT_SCHEMA;
  const tenantsTable = qualifyPostgresSessionTable("openclaw_session_tenants", schema);
  const gatewaysTable = qualifyPostgresSessionTable("openclaw_session_gateways", schema);
  const agentsTable = qualifyPostgresSessionTable("openclaw_session_agents", schema);
  const sessionsTable = qualifyPostgresSessionTable("openclaw_sessions", schema);
  const turnsTable = qualifyPostgresSessionTable("openclaw_session_turns", schema);
  const chunksTable = qualifyPostgresSessionTable("openclaw_transcript_chunks", schema);
  const defaultAgentId = normalizeAgentId(options.defaultAgentId ?? DEFAULT_AGENT_ID);
  const resolveAgentId = (storePath: string, sessionKey: string, entry: SessionEntry) => {
    const resolved = options.resolveAgentId?.({ storePath, sessionKey, entry });
    return normalizeAgentId(resolved ?? defaultAgentId);
  };
  const ensureIdentityRows = async (storePath: string, agentIds: string[]) => {
    await client.query(
      `INSERT INTO ${tenantsTable} (tenant_id, updated_at)
       VALUES ($1, now())
       ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now()`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO ${gatewaysTable} (tenant_id, gateway_id, session_dir, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id, gateway_id) DO UPDATE SET session_dir = EXCLUDED.session_dir, updated_at = now()`,
      [tenantId, gatewayId, storePath],
    );
    for (const agentId of agentIds) {
      await client.query(
        `INSERT INTO ${agentsTable} (tenant_id, gateway_id, agent_id, session_dir, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, gateway_id, agent_id) DO UPDATE SET session_dir = EXCLUDED.session_dir, updated_at = now()`,
        [tenantId, gatewayId, agentId, storePath],
      );
    }
  };

  const adapter: SessionStoreAdapter = {
    kind: "postgres",

    async loadStore(storePath: string): Promise<SessionStoreRecord> {
      const values: unknown[] = [];
      const where = buildWhereClause({ tenantId, gatewayId, storePath, values });
      const result = await client.query<SessionRow>(
        `SELECT session_key, entry_json FROM ${sessionsTable} WHERE ${where} ORDER BY session_key ASC`,
        values,
      );
      return Object.fromEntries(
        result.rows.map((row) => [
          decodeSessionKey(row.session_key),
          decodeSessionEntry(row.entry_json),
        ]),
      );
    },

    async readEntry(storePath: string, sessionKey: string): Promise<SessionEntry | undefined> {
      const values: unknown[] = [];
      const where = buildWhereClause({
        tenantId,
        gatewayId,
        storePath,
        values,
        keys: [sessionKey],
      });
      const result = await client.query<SessionRow>(
        `SELECT session_key, entry_json FROM ${sessionsTable} WHERE ${where} LIMIT 1`,
        values,
      );
      const row = result.rows[0];
      return row ? decodeSessionEntry(row.entry_json) : undefined;
    },

    async listEntries(
      storePath: string,
      options?: SessionStoreListOptions,
    ): Promise<SessionStoreListResult> {
      const normalized = normalizeSessionStoreListOptions(options);
      const values: unknown[] = [];
      const where = buildWhereClause({
        tenantId,
        gatewayId,
        storePath,
        values,
        keys: normalized.keys,
        excludeKeys: normalized.excludeKeys,
        label: normalized.label,
        spawnedBy: normalized.spawnedBy,
        search: normalized.search,
        updatedAfter: normalized.updatedAfter,
      });
      const countValues = [...values];
      const limit = normalized.limit;
      const offset = normalized.offset;
      const limitSql = limit === undefined ? "" : ` LIMIT $${values.push(limit)}`;
      const offsetSql = offset > 0 ? ` OFFSET $${values.push(offset)}` : "";
      const result = await client.query<SessionRow>(
        `SELECT session_key, entry_json, count(*) OVER() AS total_count FROM ${sessionsTable} WHERE ${where} ORDER BY ${orderBySql(normalized.orderBy)}${limitSql}${offsetSql}`,
        values,
      );
      const entries = result.rows.map((row) => [
        decodeSessionKey(row.session_key),
        decodeSessionEntry(row.entry_json),
      ]) satisfies Array<[string, SessionEntry]>;
      const totalCount = await resolvePagedTotalCount({
        client,
        rows: result.rows,
        decodedLength: entries.length,
        offset,
        countSql: `SELECT count(*) AS total_count FROM ${sessionsTable} WHERE ${where}`,
        countValues,
      });
      const nextOffset =
        limit !== undefined && offset + limit < totalCount ? offset + limit : undefined;
      return {
        entries,
        totalCount,
        ...(limit !== undefined ? { limitApplied: limit } : {}),
        ...(offset > 0 ? { offset } : {}),
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        hasMore: nextOffset !== undefined,
      };
    },

    async saveStore(
      storePath: string,
      store: SessionStoreRecord,
      _options?: SessionStoreMutationOptions,
    ): Promise<void> {
      const entries = normalizeStoreEntries(store);
      const keys = entries.map(([sessionKey]) => sessionKey);
      const entryRows = entries.map(([sessionKey, entry]) => ({
        sessionKey,
        entry,
        agentId: resolveAgentId(storePath, sessionKey, entry),
      }));
      const agentIds = Array.from(new Set(entryRows.map((entry) => entry.agentId))).toSorted(
        (left, right) => left.localeCompare(right),
      );
      await client.query("BEGIN");
      try {
        await ensureIdentityRows(storePath, agentIds);
        await client.query(
          `DELETE FROM ${sessionsTable} WHERE tenant_id = $1 AND gateway_id = $2 AND store_path = $3 AND NOT (session_key = ANY($4::text[]))`,
          [tenantId, gatewayId, storePath, keys],
        );
        for (const { sessionKey, entry, agentId } of entryRows) {
          await client.query(
            `INSERT INTO ${sessionsTable} (tenant_id, gateway_id, agent_id, store_path, session_key, session_id, updated_at_ms, entry_json, deleted_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NULL, now())
             ON CONFLICT (tenant_id, gateway_id, store_path, session_key)
             DO UPDATE SET store_path = EXCLUDED.store_path, session_id = EXCLUDED.session_id, updated_at_ms = EXCLUDED.updated_at_ms, entry_json = EXCLUDED.entry_json, deleted_at = NULL, updated_at = now()`,
            [
              tenantId,
              gatewayId,
              agentId,
              storePath,
              sessionKey,
              sessionIdForEntry(entry),
              updatedAtForEntry(entry),
              entryToJsonbParam(entry),
            ],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },

    async writeEntries(
      storePath: string,
      entries,
      _options?: SessionStoreMutationOptions,
    ): Promise<void> {
      if (entries.length === 0) {
        return;
      }
      const entryRows = entries.map(([sessionKey, entry]) => ({
        sessionKey,
        entry,
        agentId: resolveAgentId(storePath, sessionKey, entry),
      }));
      const agentIds = Array.from(new Set(entryRows.map((entry) => entry.agentId))).toSorted(
        (left, right) => left.localeCompare(right),
      );
      await client.query("BEGIN");
      try {
        await ensureIdentityRows(storePath, agentIds);
        for (const { sessionKey, entry, agentId } of entryRows) {
          await client.query(
            `INSERT INTO ${sessionsTable} (tenant_id, gateway_id, agent_id, store_path, session_key, session_id, updated_at_ms, entry_json, deleted_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NULL, now())
             ON CONFLICT (tenant_id, gateway_id, store_path, session_key)
             DO UPDATE SET agent_id = EXCLUDED.agent_id, session_id = EXCLUDED.session_id, updated_at_ms = EXCLUDED.updated_at_ms, entry_json = EXCLUDED.entry_json, deleted_at = NULL, updated_at = now()`,
            [
              tenantId,
              gatewayId,
              agentId,
              storePath,
              sessionKey,
              sessionIdForEntry(entry),
              updatedAtForEntry(entry),
              entryToJsonbParam(entry),
            ],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },

    async deleteEntries(storePath: string, sessionKeys): Promise<void> {
      if (sessionKeys.length === 0) {
        return;
      }
      await client.query(
        `UPDATE ${sessionsTable}
         SET deleted_at = now(), updated_at = now()
         WHERE tenant_id = $1
           AND gateway_id = $2
           AND store_path = $3
           AND session_key = ANY($4::text[])
           AND deleted_at IS NULL`,
        [tenantId, gatewayId, storePath, [...sessionKeys]],
      );
    },

    async writeTranscriptChunks(storePath, sessionKey, chunks, options): Promise<void> {
      if (chunks.length === 0) {
        return;
      }
      const agentId = normalizeAgentId(options?.agentId ?? defaultAgentId);
      await client.query("BEGIN");
      try {
        await ensureIdentityRows(storePath, [agentId]);
        for (const chunk of chunks) {
          await client.query(
            `INSERT INTO ${chunksTable} (tenant_id, gateway_id, agent_id, store_path, session_key, chunk_seq, transcript_path, content_sha256, bytes, chunk_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
             ON CONFLICT (tenant_id, gateway_id, store_path, session_key, chunk_seq)
             DO UPDATE SET agent_id = EXCLUDED.agent_id, transcript_path = EXCLUDED.transcript_path, content_sha256 = EXCLUDED.content_sha256, bytes = EXCLUDED.bytes, chunk_json = EXCLUDED.chunk_json`,
            [
              tenantId,
              gatewayId,
              agentId,
              storePath,
              sessionKey,
              Math.max(0, Math.floor(chunk.chunkSeq)),
              chunk.transcriptPath ?? null,
              chunk.contentSha256,
              Math.max(0, Math.floor(chunk.bytes)),
              JSON.stringify(chunk.chunkJson),
            ],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },

    async listTranscriptChunks(
      storePath: string,
      sessionKey: string,
      options?: SessionTranscriptChunkListOptions,
    ): Promise<SessionTranscriptChunkListResult> {
      const normalized = normalizeSessionTranscriptChunkListOptions(options);
      const values: unknown[] = [tenantId, gatewayId, storePath, sessionKey];
      const transcriptPathClause = normalized.transcriptPath
        ? ` AND transcript_path = $${values.push(normalized.transcriptPath)}`
        : "";
      const countValues = [...values];
      const limit = normalized.limit;
      const offset = normalized.offset;
      const limitSql = limit === undefined ? "" : ` LIMIT $${values.push(limit)}`;
      const offsetSql = offset > 0 ? ` OFFSET $${values.push(offset)}` : "";
      const result = await client.query<TranscriptChunkRow>(
        `SELECT chunk_seq, transcript_path, content_sha256, bytes, chunk_json, count(*) OVER() AS total_count
         FROM ${chunksTable}
         WHERE tenant_id = $1 AND gateway_id = $2 AND store_path = $3 AND session_key = $4${transcriptPathClause}
         ORDER BY ${chunkOrderBySql(normalized.orderBy)}${limitSql}${offsetSql}`,
        values,
      );
      const chunks = result.rows.map((row) => decodeTranscriptChunk(row));
      const totalCount = await resolvePagedTotalCount({
        client,
        rows: result.rows,
        decodedLength: chunks.length,
        offset,
        countSql: `SELECT count(*) AS total_count
         FROM ${chunksTable}
         WHERE tenant_id = $1 AND gateway_id = $2 AND store_path = $3 AND session_key = $4${transcriptPathClause}`,
        countValues,
      });
      const nextOffset =
        limit !== undefined && offset + limit < totalCount ? offset + limit : undefined;
      return {
        chunks,
        totalCount,
        ...(limit !== undefined ? { limitApplied: limit } : {}),
        ...(offset > 0 ? { offset } : {}),
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        hasMore: nextOffset !== undefined,
      };
    },

    async writeSessionTurns(storePath, sessionKey, turns, options): Promise<void> {
      if (turns.length === 0) {
        return;
      }
      const agentId = normalizeAgentId(options?.agentId ?? defaultAgentId);
      await client.query("BEGIN");
      try {
        await ensureIdentityRows(storePath, [agentId]);
        for (const turn of turns) {
          await client.query(
            `INSERT INTO ${turnsTable} (tenant_id, gateway_id, agent_id, store_path, session_key, turn_seq, role, model_provider, model, input_tokens, output_tokens, started_at, ended_at, metadata_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz, $14::jsonb)
             ON CONFLICT (tenant_id, gateway_id, store_path, session_key, turn_seq)
             DO UPDATE SET agent_id = EXCLUDED.agent_id, role = EXCLUDED.role, model_provider = EXCLUDED.model_provider, model = EXCLUDED.model, input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens, started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at, metadata_json = EXCLUDED.metadata_json`,
            [
              tenantId,
              gatewayId,
              agentId,
              storePath,
              sessionKey,
              Math.max(0, Math.floor(turn.turnSeq)),
              turn.role,
              turn.modelProvider ?? null,
              turn.model ?? null,
              typeof turn.inputTokens === "number" && Number.isFinite(turn.inputTokens)
                ? Math.max(0, Math.floor(turn.inputTokens))
                : null,
              typeof turn.outputTokens === "number" && Number.isFinite(turn.outputTokens)
                ? Math.max(0, Math.floor(turn.outputTokens))
                : null,
              turn.startedAt ?? null,
              turn.endedAt ?? null,
              JSON.stringify(turn.metadataJson ?? {}),
            ],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },

    async listSessionTurns(
      storePath: string,
      sessionKey: string,
      options?: SessionTurnListOptions,
    ): Promise<SessionTurnListResult> {
      const normalized = normalizeSessionTurnListOptions(options);
      const values: unknown[] = [tenantId, gatewayId, storePath, sessionKey];
      const countValues = [...values];
      const limit = normalized.limit;
      const offset = normalized.offset;
      const limitSql = limit === undefined ? "" : ` LIMIT $${values.push(limit)}`;
      const offsetSql = offset > 0 ? ` OFFSET $${values.push(offset)}` : "";
      const result = await client.query<SessionTurnRow>(
        `SELECT turn_seq, role, model_provider, model, input_tokens, output_tokens, started_at::text AS started_at, ended_at::text AS ended_at, metadata_json, count(*) OVER() AS total_count
         FROM ${turnsTable}
         WHERE tenant_id = $1 AND gateway_id = $2 AND store_path = $3 AND session_key = $4
         ORDER BY ${turnOrderBySql(normalized.orderBy)}${limitSql}${offsetSql}`,
        values,
      );
      const turns = result.rows.map((row) => decodeSessionTurn(row));
      const totalCount = await resolvePagedTotalCount({
        client,
        rows: result.rows,
        decodedLength: turns.length,
        offset,
        countSql: `SELECT count(*) AS total_count
         FROM ${turnsTable}
         WHERE tenant_id = $1 AND gateway_id = $2 AND store_path = $3 AND session_key = $4`,
        countValues,
      });
      const nextOffset =
        limit !== undefined && offset + limit < totalCount ? offset + limit : undefined;
      return {
        turns,
        totalCount,
        ...(limit !== undefined ? { limitApplied: limit } : {}),
        ...(offset > 0 ? { offset } : {}),
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        hasMore: nextOffset !== undefined,
      };
    },

    async updateStore<T>(
      storePath: string,
      mutator: (store: SessionStoreRecord) => T | Promise<T>,
      options?: SessionStoreMutationOptions,
    ): Promise<T> {
      const store = await adapter.loadStore(storePath);
      const result = await mutator(store);
      await adapter.saveStore(storePath, store, options);
      return result;
    },
  };

  return adapter;
}
