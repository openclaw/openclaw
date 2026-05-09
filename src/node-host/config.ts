import crypto from "node:crypto";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";

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

const NODE_HOST_CONFIG_SCOPE = "node-host.config";
const NODE_HOST_CONFIG_KEY = "current";

function sqliteOptionsForEnv(env: NodeJS.ProcessEnv): OpenClawStateDatabaseOptions {
  return { env };
}

function coercePartialConfig(value: unknown): Partial<NodeHostConfig> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Partial<NodeHostConfig>)
    : null;
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

export async function loadNodeHostConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeHostConfig | null> {
  const parsed = coercePartialConfig(
    readOpenClawStateKvJson(NODE_HOST_CONFIG_SCOPE, NODE_HOST_CONFIG_KEY, sqliteOptionsForEnv(env)),
  );
  return parsed ? normalizeConfig(parsed) : null;
}

export async function saveNodeHostConfig(
  config: NodeHostConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  writeOpenClawStateKvJson<OpenClawStateJsonValue>(
    NODE_HOST_CONFIG_SCOPE,
    NODE_HOST_CONFIG_KEY,
    normalizeConfig(config) as unknown as OpenClawStateJsonValue,
    sqliteOptionsForEnv(env),
  );
}

export async function ensureNodeHostConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeHostConfig> {
  const existing = await loadNodeHostConfig(env);
  const normalized = normalizeConfig(existing);
  await saveNodeHostConfig(normalized, env);
  return normalized;
}
