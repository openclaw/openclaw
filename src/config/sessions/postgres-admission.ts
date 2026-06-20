import { qualifyPostgresSessionTable } from "./postgres-schema.js";
import type {
  PostgresSessionStoreQueryClient,
  PostgresSessionStoreQueryRow,
} from "./postgres-store-adapter.js";

export type PostgresSessionAdmissionOptions = {
  tenantId: string;
  gatewayId: string;
  schema?: string;
};

export type SessionStoreLeaseRequest = {
  leaseKey: string;
  holderId: string;
  ttlMs: number;
  metadata?: Record<string, unknown>;
};

export type SessionStoreLeaseResult = {
  acquired: boolean;
  leaseKey: string;
  holderId?: string;
  expiresAt?: string;
  reason?: "held";
};

export type SessionStoreBackpressureSnapshot = {
  lane: string;
  admitted: number;
  running: number;
  queued: number;
  rejected: number;
  maxRunning?: number;
  maxQueued?: number;
};

export type SessionStoreLaneAdmissionRequest = {
  lane: string;
  runningCost?: number;
  maxRunning?: number;
  maxQueued?: number;
};

export type SessionStoreLaneAdmissionResult = {
  admitted: boolean;
  reason?: "max_running";
  snapshot?: SessionStoreBackpressureSnapshot;
};

export type SessionStoreLaneReleaseRequest = {
  lane: string;
  runningCost?: number;
};

export type SessionStoreGatewayHealth = {
  processId?: number;
  eventLoopLagMs?: number;
  configPath?: string;
  stateDir?: string;
  sessionDir?: string;
};

export type PostgresSessionAdmissionController = {
  tryAcquireLease(request: SessionStoreLeaseRequest): Promise<SessionStoreLeaseResult>;
  releaseLease(request: { leaseKey: string; holderId: string }): Promise<boolean>;
  admitLane(request: SessionStoreLaneAdmissionRequest): Promise<SessionStoreLaneAdmissionResult>;
  releaseLaneRun(
    request: SessionStoreLaneReleaseRequest,
  ): Promise<SessionStoreBackpressureSnapshot | undefined>;
  recordGatewayHealth(health: SessionStoreGatewayHealth): Promise<void>;
};

type LeaseRow = PostgresSessionStoreQueryRow & {
  lease_key?: unknown;
  holder_id?: unknown;
  expires_at?: unknown;
};

type BackpressureRow = PostgresSessionStoreQueryRow & {
  lane?: unknown;
  admitted?: unknown;
  running?: unknown;
  queued?: unknown;
  rejected?: unknown;
  max_running?: unknown;
  max_queued?: unknown;
};

const DEFAULT_SCHEMA = "openclaw";

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function normalizePositiveInteger(value: number | undefined, defaultValue: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.max(1, Math.floor(value));
}

function nullableLimit(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}

function optionalInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function integerOrZero(value: unknown): number {
  return optionalInteger(value) ?? 0;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function timestampOrUndefined(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return stringOrUndefined(value);
}

function snapshotFromRow(
  row: BackpressureRow | undefined,
  laneFallback: string,
): SessionStoreBackpressureSnapshot | undefined {
  if (!row) {
    return undefined;
  }
  const maxRunning = optionalInteger(row.max_running);
  const maxQueued = optionalInteger(row.max_queued);
  return {
    lane: stringOrUndefined(row.lane) ?? laneFallback,
    admitted: integerOrZero(row.admitted),
    running: integerOrZero(row.running),
    queued: integerOrZero(row.queued),
    rejected: integerOrZero(row.rejected),
    ...(maxRunning !== undefined ? { maxRunning } : {}),
    ...(maxQueued !== undefined ? { maxQueued } : {}),
  };
}

export function createPostgresSessionAdmissionController(
  client: PostgresSessionStoreQueryClient,
  options: PostgresSessionAdmissionOptions,
): PostgresSessionAdmissionController {
  const tenantId = requireNonEmpty(options.tenantId, "tenantId");
  const gatewayId = requireNonEmpty(options.gatewayId, "gatewayId");
  const schema = options.schema ?? DEFAULT_SCHEMA;
  const tenantsTable = qualifyPostgresSessionTable("openclaw_session_tenants", schema);
  const gatewaysTable = qualifyPostgresSessionTable("openclaw_session_gateways", schema);
  const leasesTable = qualifyPostgresSessionTable("openclaw_session_leases", schema);
  const backpressureTable = qualifyPostgresSessionTable("openclaw_session_backpressure", schema);

  const ensureTenantAndGateway = async (health?: SessionStoreGatewayHealth) => {
    await client.query(
      `INSERT INTO ${tenantsTable} (tenant_id, updated_at)
       VALUES ($1, now())
       ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now()`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO ${gatewaysTable} (tenant_id, gateway_id, config_path, state_dir, session_dir, process_id, event_loop_lag_ms, heartbeat_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
       ON CONFLICT (tenant_id, gateway_id)
       DO UPDATE SET config_path = COALESCE(EXCLUDED.config_path, ${gatewaysTable}.config_path),
                     state_dir = COALESCE(EXCLUDED.state_dir, ${gatewaysTable}.state_dir),
                     session_dir = COALESCE(EXCLUDED.session_dir, ${gatewaysTable}.session_dir),
                     process_id = COALESCE(EXCLUDED.process_id, ${gatewaysTable}.process_id),
                     event_loop_lag_ms = COALESCE(EXCLUDED.event_loop_lag_ms, ${gatewaysTable}.event_loop_lag_ms),
                     heartbeat_at = now(),
                     updated_at = now()`,
      [
        tenantId,
        gatewayId,
        health?.configPath ?? null,
        health?.stateDir ?? null,
        health?.sessionDir ?? null,
        typeof health?.processId === "number" && Number.isFinite(health.processId)
          ? Math.floor(health.processId)
          : null,
        typeof health?.eventLoopLagMs === "number" && Number.isFinite(health.eventLoopLagMs)
          ? Math.max(0, Math.floor(health.eventLoopLagMs))
          : null,
      ],
    );
  };

  return {
    async tryAcquireLease(request: SessionStoreLeaseRequest): Promise<SessionStoreLeaseResult> {
      const leaseKey = requireNonEmpty(request.leaseKey, "leaseKey");
      const holderId = requireNonEmpty(request.holderId, "holderId");
      const ttlMs = normalizePositiveInteger(request.ttlMs, 1);
      await ensureTenantAndGateway();
      const result = await client.query<LeaseRow>(
        `INSERT INTO ${leasesTable} (tenant_id, gateway_id, lease_key, holder_id, expires_at, metadata_json)
         VALUES ($1, $2, $3, $4, now() + ($5::text)::interval, $6::jsonb)
         ON CONFLICT (tenant_id, gateway_id, lease_key)
         DO UPDATE SET holder_id = EXCLUDED.holder_id,
                       acquired_at = now(),
                       expires_at = EXCLUDED.expires_at,
                       metadata_json = EXCLUDED.metadata_json
         WHERE ${leasesTable}.expires_at <= now() OR ${leasesTable}.holder_id = EXCLUDED.holder_id
         RETURNING lease_key, holder_id, expires_at`,
        [
          tenantId,
          gatewayId,
          leaseKey,
          holderId,
          `${ttlMs} milliseconds`,
          JSON.stringify(request.metadata ?? {}),
        ],
      );
      const acquired = result.rows[0];
      if (acquired) {
        return {
          acquired: true,
          leaseKey,
          holderId: stringOrUndefined(acquired.holder_id) ?? holderId,
          expiresAt: timestampOrUndefined(acquired.expires_at),
        };
      }
      const current = await client.query<LeaseRow>(
        `SELECT lease_key, holder_id, expires_at FROM ${leasesTable}
         WHERE tenant_id = $1 AND gateway_id = $2 AND lease_key = $3`,
        [tenantId, gatewayId, leaseKey],
      );
      const row = current.rows[0];
      return {
        acquired: false,
        leaseKey,
        holderId: stringOrUndefined(row?.holder_id),
        expiresAt: timestampOrUndefined(row?.expires_at),
        reason: "held",
      };
    },

    async releaseLease(request: { leaseKey: string; holderId: string }): Promise<boolean> {
      const leaseKey = requireNonEmpty(request.leaseKey, "leaseKey");
      const holderId = requireNonEmpty(request.holderId, "holderId");
      const result = await client.query(
        `DELETE FROM ${leasesTable}
         WHERE tenant_id = $1 AND gateway_id = $2 AND lease_key = $3 AND holder_id = $4`,
        [tenantId, gatewayId, leaseKey, holderId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async admitLane(
      request: SessionStoreLaneAdmissionRequest,
    ): Promise<SessionStoreLaneAdmissionResult> {
      const lane = requireNonEmpty(request.lane, "lane");
      const runningCost = normalizePositiveInteger(request.runningCost, 1);
      const maxRunning = nullableLimit(request.maxRunning);
      const maxQueued = nullableLimit(request.maxQueued);
      await ensureTenantAndGateway();
      await client.query(
        `INSERT INTO ${backpressureTable} (tenant_id, gateway_id, lane, max_running, max_queued, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (tenant_id, gateway_id, lane)
         DO UPDATE SET max_running = EXCLUDED.max_running,
                       max_queued = EXCLUDED.max_queued,
                       updated_at = now()`,
        [tenantId, gatewayId, lane, maxRunning, maxQueued],
      );
      const admitted = await client.query<BackpressureRow>(
        `UPDATE ${backpressureTable}
         SET admitted = admitted + 1,
             running = running + $4,
             updated_at = now()
         WHERE tenant_id = $1
           AND gateway_id = $2
           AND lane = $3
           AND ($5::integer IS NULL OR running + $4 <= $5)
         RETURNING lane, admitted, running, queued, rejected, max_running, max_queued`,
        [tenantId, gatewayId, lane, runningCost, maxRunning],
      );
      const admittedSnapshot = snapshotFromRow(admitted.rows[0], lane);
      if (admittedSnapshot) {
        return { admitted: true, snapshot: admittedSnapshot };
      }
      const rejected = await client.query<BackpressureRow>(
        `UPDATE ${backpressureTable}
         SET rejected = rejected + 1,
             updated_at = now()
         WHERE tenant_id = $1 AND gateway_id = $2 AND lane = $3
         RETURNING lane, admitted, running, queued, rejected, max_running, max_queued`,
        [tenantId, gatewayId, lane],
      );
      return {
        admitted: false,
        reason: "max_running",
        snapshot: snapshotFromRow(rejected.rows[0], lane),
      };
    },

    async releaseLaneRun(
      request: SessionStoreLaneReleaseRequest,
    ): Promise<SessionStoreBackpressureSnapshot | undefined> {
      const lane = requireNonEmpty(request.lane, "lane");
      const runningCost = normalizePositiveInteger(request.runningCost, 1);
      const result = await client.query<BackpressureRow>(
        `UPDATE ${backpressureTable}
         SET running = GREATEST(0, running - $4),
             updated_at = now()
         WHERE tenant_id = $1 AND gateway_id = $2 AND lane = $3
         RETURNING lane, admitted, running, queued, rejected, max_running, max_queued`,
        [tenantId, gatewayId, lane, runningCost],
      );
      return snapshotFromRow(result.rows[0], lane);
    },

    async recordGatewayHealth(health: SessionStoreGatewayHealth): Promise<void> {
      await ensureTenantAndGateway(health);
    },
  };
}
