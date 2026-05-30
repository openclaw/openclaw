import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { writeJson } from "../infra/json-files.js";

export type NodeHostGatewayConfig = {
  host?: string;
  port?: number;
  tls?: boolean;
  tlsFingerprint?: string;
};

type NodeHostNodeIdSource = "generated" | "user";

type NodeHostConfig = {
  version: 1;
  nodeId: string;
  nodeIdSource?: NodeHostNodeIdSource;
  token?: string;
  displayName?: string;
  gateway?: NodeHostGatewayConfig;
};

const NODE_HOST_FILE = "node.json";

function resolveNodeHostConfigPath(): string {
  return path.join(resolveStateDir(), NODE_HOST_FILE);
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function normalizeNodeIdSource(
  config: Partial<NodeHostConfig> | null,
  nodeId: string,
): NodeHostNodeIdSource {
  if (config?.nodeIdSource === "generated" || config?.nodeIdSource === "user") {
    return config.nodeIdSource;
  }
  return isUuidLike(nodeId) ? "generated" : "user";
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
    base.nodeIdSource = "generated";
  } else {
    base.nodeIdSource = normalizeNodeIdSource(config, base.nodeId);
  }
  return base;
}

export async function loadNodeHostConfig(): Promise<NodeHostConfig | null> {
  const filePath = resolveNodeHostConfigPath();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<NodeHostConfig>;
    return normalizeConfig(parsed);
  } catch {
    return null;
  }
}

export async function saveNodeHostConfig(config: NodeHostConfig): Promise<void> {
  const filePath = resolveNodeHostConfigPath();
  await writeJson(filePath, config, { mode: 0o600 });
}

export async function ensureNodeHostConfig(): Promise<NodeHostConfig> {
  const existing = await loadNodeHostConfig();
  const normalized = normalizeConfig(existing);
  await saveNodeHostConfig(normalized);
  return normalized;
}
