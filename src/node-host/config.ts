import crypto from "node:crypto";
import {
  getCoreSettingFromDb,
  setCoreSettingInDb,
} from "../infra/state-db/core-settings-sqlite.js";

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

const SCOPE = "node-host";
const KEY = "config";

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

export async function loadNodeHostConfig(): Promise<NodeHostConfig | null> {
  const raw = getCoreSettingFromDb<Partial<NodeHostConfig>>(SCOPE, KEY);
  if (!raw) {
    return null;
  }
  return normalizeConfig(raw);
}

export async function saveNodeHostConfig(config: NodeHostConfig): Promise<void> {
  setCoreSettingInDb(SCOPE, KEY, config);
}

export async function ensureNodeHostConfig(): Promise<NodeHostConfig> {
  const existing = await loadNodeHostConfig();
  const normalized = normalizeConfig(existing);
  await saveNodeHostConfig(normalized);
  return normalized;
}
