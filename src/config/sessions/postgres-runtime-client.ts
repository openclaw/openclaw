import { createRequire } from "node:module";
import {
  PostgresSessionStoreRuntimeConfigError,
  readPostgresSessionStoreRuntimeConfig,
  type EnabledPostgresSessionStoreRuntimeConfig,
} from "./postgres-runtime-config.js";
import { createPostgresSessionStoreAdapter } from "./postgres-store-adapter.js";
import type {
  PostgresSessionStoreQueryClient,
  PostgresSessionStoreQueryResult,
  PostgresSessionStoreQueryRow,
} from "./postgres-store-adapter.js";
import type { SessionStoreAdapter } from "./storage-adapter.js";
import {
  configureSessionStoreRuntimeAdapterFactory,
  readSessionStoreBackendConfig,
} from "./store-async.js";
import {
  createInMemorySessionStoreMetricsRecorder,
  instrumentSessionStoreAdapter,
  type SessionStoreMetricsRecorder,
  type SessionStoreOperationMetric,
} from "./store-observability.js";

export type PgPoolLike = {
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: PostgresSessionStoreQueryRow[]; rowCount?: number | null }>;
  end(): Promise<void>;
};

export type PgModuleLike = {
  Pool: new (options: Record<string, unknown>) => PgPoolLike;
};

export type LazyPostgresSessionStoreQueryClient = PostgresSessionStoreQueryClient & {
  end(): Promise<void>;
  getPoolForTest(): PgPoolLike | undefined;
};

export type CreateLazyPostgresSessionStoreQueryClientOptions = {
  loadPg?: () => PgModuleLike | Promise<PgModuleLike>;
};

const require = createRequire(import.meta.url);

function formatPgLoadError(error: unknown): PostgresSessionStoreRuntimeConfigError {
  if (error instanceof PostgresSessionStoreRuntimeConfigError) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new PostgresSessionStoreRuntimeConfigError(
    `OPENCLAW_SESSION_STORE_BACKEND=postgres requires optional package "pg" to be installed: ${detail}`,
  );
}

async function defaultLoadPg(): Promise<PgModuleLike> {
  try {
    return require("pg") as PgModuleLike;
  } catch (error) {
    throw formatPgLoadError(error);
  }
}

function createPgPoolOptions(config: EnabledPostgresSessionStoreRuntimeConfig) {
  return {
    connectionString: config.connectionString,
    max: config.pool.max,
    idleTimeoutMillis: config.pool.idleTimeoutMs,
    connectionTimeoutMillis: config.pool.connectionTimeoutMs,
    statement_timeout: config.pool.statementTimeoutMs,
    application_name: config.pool.applicationName,
  };
}

export function createLazyPostgresSessionStoreQueryClient(
  config: EnabledPostgresSessionStoreRuntimeConfig,
  options: CreateLazyPostgresSessionStoreQueryClientOptions = {},
): LazyPostgresSessionStoreQueryClient {
  const loadPg = options.loadPg ?? defaultLoadPg;
  let poolPromise: Promise<PgPoolLike> | undefined;
  let pool: PgPoolLike | undefined;

  async function getPool(): Promise<PgPoolLike> {
    if (!poolPromise) {
      poolPromise = Promise.resolve()
        .then(() => loadPg())
        .then((pg) => {
          pool = new pg.Pool(createPgPoolOptions(config));
          return pool;
        })
        .catch((error: unknown) => {
          poolPromise = undefined;
          throw formatPgLoadError(error);
        });
    }
    return await poolPromise;
  }

  return {
    async query<TRow extends PostgresSessionStoreQueryRow = PostgresSessionStoreQueryRow>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<PostgresSessionStoreQueryResult<TRow>> {
      const activePool = await getPool();
      const result = await activePool.query(sql, values);
      return {
        rows: result.rows as TRow[],
        rowCount: result.rowCount,
      };
    },
    async end(): Promise<void> {
      if (!poolPromise) {
        return;
      }
      const activePool = await poolPromise;
      await activePool.end();
    },
    getPoolForTest(): PgPoolLike | undefined {
      return pool;
    },
  };
}

export type InstallPostgresSessionStoreRuntimeAdapterFactoryOptions = {
  env?: Record<string, string | undefined>;
  loadPg?: () => PgModuleLike | Promise<PgModuleLike>;
  metricsRecorder?: SessionStoreMetricsRecorder;
};

export type InstalledPostgresSessionStoreRuntimeAdapterFactory = {
  enabled: boolean;
  adapter?: SessionStoreAdapter;
  redactedConnectionString?: string;
  metrics?: readonly SessionStoreOperationMetric[];
  cleanup(): Promise<void>;
};

export type PostgresSessionStoreRuntimeMetricsSummary = {
  backend: "postgres";
  totalOperations: number;
  failedOperations: number;
  recentOperations: Array<
    Pick<
      SessionStoreOperationMetric,
      | "operation"
      | "ok"
      | "durationMs"
      | "entryCount"
      | "chunkCount"
      | "turnCount"
      | "byteCount"
      | "totalCount"
      | "hasMore"
      | "errorName"
      | "errorMessage"
    >
  >;
};

let activeRuntimeMetrics: readonly SessionStoreOperationMetric[] | undefined;

function summarizeRuntimeOperationMetric(
  metric: SessionStoreOperationMetric,
): PostgresSessionStoreRuntimeMetricsSummary["recentOperations"][number] {
  const summarized: PostgresSessionStoreRuntimeMetricsSummary["recentOperations"][number] = {
    operation: metric.operation,
    ok: metric.ok,
    durationMs: metric.durationMs,
  };
  if (metric.entryCount !== undefined) {
    summarized.entryCount = metric.entryCount;
  }
  if (metric.chunkCount !== undefined) {
    summarized.chunkCount = metric.chunkCount;
  }
  if (metric.turnCount !== undefined) {
    summarized.turnCount = metric.turnCount;
  }
  if (metric.byteCount !== undefined) {
    summarized.byteCount = metric.byteCount;
  }
  if (metric.totalCount !== undefined) {
    summarized.totalCount = metric.totalCount;
  }
  if (metric.hasMore !== undefined) {
    summarized.hasMore = metric.hasMore;
  }
  if (metric.errorName !== undefined) {
    summarized.errorName = metric.errorName;
  }
  if (metric.errorMessage !== undefined) {
    summarized.errorMessage = metric.errorMessage;
  }
  return summarized;
}

export function getPostgresSessionStoreRuntimeMetricsSummary(
  options: {
    limit?: number;
  } = {},
): PostgresSessionStoreRuntimeMetricsSummary | undefined {
  const metrics = activeRuntimeMetrics;
  if (!metrics) {
    return undefined;
  }
  const limit =
    typeof options.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : 20;
  const recent = limit === 0 ? [] : metrics.slice(-limit);
  return {
    backend: "postgres",
    totalOperations: metrics.length,
    failedOperations: metrics.filter((metric) => !metric.ok).length,
    recentOperations: recent.map(summarizeRuntimeOperationMetric),
  };
}

export async function installPostgresSessionStoreRuntimeAdapterFactory(
  options: InstallPostgresSessionStoreRuntimeAdapterFactoryOptions = {},
): Promise<InstalledPostgresSessionStoreRuntimeAdapterFactory> {
  const env = options.env ?? process.env;
  const config = readPostgresSessionStoreRuntimeConfig(env);
  if (!config.enabled) {
    return {
      enabled: false,
      async cleanup() {},
    };
  }

  const queryClient = createLazyPostgresSessionStoreQueryClient(
    config,
    options.loadPg ? { loadPg: options.loadPg } : {},
  );
  const defaultRecorder = options.metricsRecorder
    ? undefined
    : createInMemorySessionStoreMetricsRecorder();
  const metricsRecorder = options.metricsRecorder ?? defaultRecorder!;
  const previousRuntimeMetrics = activeRuntimeMetrics;
  if (defaultRecorder) {
    activeRuntimeMetrics = defaultRecorder.metrics;
  }
  const adapter = instrumentSessionStoreAdapter(
    createPostgresSessionStoreAdapter(queryClient, {
      tenantId: config.tenantId,
      gatewayId: config.gatewayId,
      schema: config.schema,
    }),
    { recorder: metricsRecorder },
  );
  const restore = configureSessionStoreRuntimeAdapterFactory((requestedConfig) => {
    if (requestedConfig.backend !== "postgres") {
      return undefined;
    }
    const envConfig = readSessionStoreBackendConfig(env);
    if (
      envConfig.backend !== "postgres" ||
      requestedConfig.tenantId !== config.tenantId ||
      requestedConfig.gatewayId !== config.gatewayId ||
      (requestedConfig.schema ?? undefined) !== (config.schema ?? undefined)
    ) {
      throw new PostgresSessionStoreRuntimeConfigError(
        "Postgres session-store runtime adapter factory was installed for a different tenant/gateway/schema scope",
      );
    }
    return adapter;
  });

  return {
    enabled: true,
    adapter,
    redactedConnectionString: config.redactedConnectionString,
    ...(defaultRecorder ? { metrics: defaultRecorder.metrics } : {}),
    async cleanup(): Promise<void> {
      activeRuntimeMetrics = previousRuntimeMetrics;
      restore();
      await queryClient.end();
    },
  };
}
