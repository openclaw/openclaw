import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type NodeHostGatewayConfig = {
  host?: string;
  port?: number;
  tls?: boolean;
  tlsFingerprint?: string;
};

/** Marketplace capacity-sharing opt-in configuration. */
export type NodeHostMarketplaceConfig = {
  /** Whether this node participates in the P2P marketplace. Default: false. */
  enabled: boolean;
  /** Claude API key for shared requests. Falls back to ANTHROPIC_API_KEY env. */
  claudeApiKey?: string;
  /** Seconds of inactivity before declaring idle. Default: 300 (5 min). */
  idleThresholdSec?: number;
  /** Maximum concurrent marketplace requests this node will handle. Default: 1. */
  maxConcurrent?: number;
  /** Payout preference. Default: "usd". */
  payoutPreference?: "usd" | "ai_token";
};

export type NodeHostConfig = {
  version: 1;
  nodeId: string;
  token?: string;
  displayName?: string;
  gateway?: NodeHostGatewayConfig;
  /** P2P marketplace configuration for idle compute sharing. */
  marketplace?: NodeHostMarketplaceConfig;
};

const NODE_HOST_FILE = "node.json";

export function resolveNodeHostConfigPath(): string {
  return path.join(resolveStateDir(), NODE_HOST_FILE);
}

function normalizeConfig(config: Partial<NodeHostConfig> | null): NodeHostConfig {
  const base: NodeHostConfig = {
    version: 1,
    nodeId: "",
    token: config?.token,
    displayName: config?.displayName,
    gateway: config?.gateway,
    marketplace: config?.marketplace,
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
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = JSON.stringify(config, null, 2);
  await fs.writeFile(filePath, `${payload}\n`, { mode: 0o600 });
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
}

export async function ensureNodeHostConfig(): Promise<NodeHostConfig> {
  const existing = await loadNodeHostConfig();
  const normalized = normalizeConfig(existing);
  await saveNodeHostConfig(normalized);
  return normalized;
}
