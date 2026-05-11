import crypto from "node:crypto";
import type { Insertable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { sqliteBooleanInteger, sqliteIntegerBoolean } from "../infra/sqlite-row-values.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

export type NodeHostGatewayConfig = {
  host?: string;
  port?: number;
  tls?: boolean;
  tlsFingerprint?: string;
};

export type NodeHostConfig = {
  version: 1;
  nodeId: string;
  token?: string;
  displayName?: string;
  gateway?: NodeHostGatewayConfig;
};

const NODE_HOST_CONFIG_KEY = "current";

type NodeHostConfigDatabase = Pick<OpenClawStateKyselyDatabase, "node_host_config">;
type NodeHostConfigInsert = Insertable<NodeHostConfigDatabase["node_host_config"]>;

type NodeHostConfigRow = {
  version: number | bigint;
  node_id: string;
  token: string | null;
  display_name: string | null;
  gateway_host: string | null;
  gateway_port: number | bigint | null;
  gateway_tls: number | bigint | null;
  gateway_tls_fingerprint: string | null;
};

function sqliteOptionsForEnv(env: NodeJS.ProcessEnv): OpenClawStateDatabaseOptions {
  return { env };
}

function openNodeHostConfigDatabase(env: NodeJS.ProcessEnv) {
  const database = openOpenClawStateDatabase(sqliteOptionsForEnv(env));
  return { database, db: getNodeSqliteKysely<NodeHostConfigDatabase>(database.db) };
}

function sqliteIntegerToNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function normalizeConfig(config: Partial<NodeHostConfig> | null): NodeHostConfig {
  const base: NodeHostConfig = {
    version: 1,
    nodeId: "",
    token: config?.token,
    displayName: config?.displayName,
    gateway: config?.gateway,
  };
  if (config?.version === 1 && typeof config.nodeId === "string") {
    base.nodeId = config.nodeId.trim();
  }
  if (!base.nodeId) {
    base.nodeId = crypto.randomUUID();
  }
  return base;
}

function rowToNodeHostConfig(row: NodeHostConfigRow): NodeHostConfig {
  const gateway =
    row.gateway_host || row.gateway_port !== null || row.gateway_tls !== null
      ? {
          host: row.gateway_host ?? undefined,
          port: row.gateway_port === null ? undefined : sqliteIntegerToNumber(row.gateway_port),
          tls: sqliteIntegerBoolean(row.gateway_tls),
          tlsFingerprint: row.gateway_tls_fingerprint ?? undefined,
        }
      : undefined;
  return normalizeConfig({
    version: sqliteIntegerToNumber(row.version) === 1 ? 1 : undefined,
    nodeId: row.node_id,
    token: row.token ?? undefined,
    displayName: row.display_name ?? undefined,
    gateway,
  });
}

function nodeHostConfigToRow(config: NodeHostConfig): NodeHostConfigInsert {
  const normalized = normalizeConfig(config);
  return {
    config_key: NODE_HOST_CONFIG_KEY,
    version: normalized.version,
    node_id: normalized.nodeId,
    token: normalized.token ?? null,
    display_name: normalized.displayName ?? null,
    gateway_host: normalized.gateway?.host ?? null,
    gateway_port: normalized.gateway?.port ?? null,
    gateway_tls: sqliteBooleanInteger(normalized.gateway?.tls),
    gateway_tls_fingerprint: normalized.gateway?.tlsFingerprint ?? null,
    updated_at_ms: Date.now(),
  };
}

export async function loadNodeHostConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeHostConfig | null> {
  const { database, db } = openNodeHostConfigDatabase(env);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("node_host_config")
      .select([
        "version",
        "node_id",
        "token",
        "display_name",
        "gateway_host",
        "gateway_port",
        "gateway_tls",
        "gateway_tls_fingerprint",
      ])
      .where("config_key", "=", NODE_HOST_CONFIG_KEY),
  );
  return row ? rowToNodeHostConfig(row) : null;
}

export async function saveNodeHostConfig(
  config: NodeHostConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const row = nodeHostConfigToRow(config);
  const { config_key: _configKey, ...updates } = row;
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<NodeHostConfigDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("node_host_config")
        .values(row)
        .onConflict((conflict) => conflict.column("config_key").doUpdateSet(updates)),
    );
  }, sqliteOptionsForEnv(env));
}

export async function ensureNodeHostConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeHostConfig> {
  const existing = await loadNodeHostConfig(env);
  const normalized = normalizeConfig(existing);
  await saveNodeHostConfig(normalized, env);
  return normalized;
}
