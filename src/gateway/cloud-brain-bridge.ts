import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  BenchCloudBridgeConfig,
  BenchCloudCliTurnCreateResponse,
  BenchCloudCliTurnRequest,
} from "./bench-cloud-client.js";
import { createBenchCloudCliTurn } from "./bench-cloud-client.js";

type BenchCloudConfigSource = {
  enabled?: boolean;
  apiBaseUrl?: string;
  instanceId?: string;
  installId?: string;
  agentIdAliases?: Record<string, unknown>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

const DEFAULT_BENCH_CLOUD_AGENT_ID_ALIASES: Record<string, string> = {
  "kestrel-aurelius": "aurelius",
};

function boolFromEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  return undefined;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeAgentIdForCloud(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : undefined;
}

function normalizeAgentIdAliases(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const aliases: Record<string, string> = {};
  for (const [from, to] of Object.entries(value as Record<string, unknown>)) {
    const normalizedFrom = normalizeAgentIdForCloud(from);
    const normalizedTo = normalizeAgentIdForCloud(to);
    if (normalizedFrom && normalizedTo) {
      aliases[normalizedFrom] = normalizedTo;
    }
  }
  return aliases;
}

export function resolveBenchCloudBridgeConfig(cfg: OpenClawConfig): BenchCloudBridgeConfig {
  const source: BenchCloudConfigSource = cfg.gateway?.benchCloud ?? {};
  const enabled =
    source.enabled ??
    boolFromEnv(process.env.BENCH_CLOUD_BRIDGE_ENABLED) ??
    boolFromEnv(process.env.BENCH_CLI_REMOTE_BRAIN_BRIDGE_ENABLED) ??
    false;
  const apiBaseUrl =
    source.apiBaseUrl ??
    process.env.BENCH_CLOUD_API_BASE_URL ??
    process.env.BENCHAGI_API_BASE_URL ??
    "https://benchagi.com";
  const instanceId = source.instanceId ?? process.env.BENCH_INSTANCE_ID;
  const installId = source.installId ?? process.env.BENCH_INSTALL_ID;
  const agentIdAliases = {
    ...DEFAULT_BENCH_CLOUD_AGENT_ID_ALIASES,
    ...normalizeAgentIdAliases(source.agentIdAliases),
  };

  return {
    enabled,
    apiBaseUrl,
    instanceId,
    installId,
    agentIdAliases,
    pollIntervalMs: positiveInt(
      source.pollIntervalMs ?? process.env.BENCH_CLOUD_BRIDGE_POLL_INTERVAL_MS,
      1000,
    ),
    pollTimeoutMs: positiveInt(
      source.pollTimeoutMs ?? process.env.BENCH_CLOUD_BRIDGE_POLL_TIMEOUT_MS,
      5 * 60 * 1000,
    ),
  };
}

export function canAttemptBenchCloudBridge(params: {
  config: BenchCloudBridgeConfig;
  authToken?: string;
}): params is { config: BenchCloudBridgeConfig & { instanceId: string }; authToken: string } {
  return Boolean(params.config.enabled && params.config.instanceId && params.authToken);
}

export function resolveBenchCloudAgentId(params: {
  config: BenchCloudBridgeConfig;
  agentId: string;
}): string {
  const normalizedAgentId = normalizeAgentIdForCloud(params.agentId);
  if (!normalizedAgentId) {
    return params.agentId;
  }
  return params.config.agentIdAliases[normalizedAgentId] ?? normalizedAgentId;
}

export async function createCliRemoteBrainTurn(params: {
  config: BenchCloudBridgeConfig & { instanceId: string };
  authToken: string;
  request: Omit<BenchCloudCliTurnRequest, "instanceId" | "installId">;
  signal?: AbortSignal;
}): Promise<BenchCloudCliTurnCreateResponse> {
  const agentId = resolveBenchCloudAgentId({
    config: params.config,
    agentId: params.request.agentId,
  });
  return createBenchCloudCliTurn({
    config: params.config,
    authToken: params.authToken,
    signal: params.signal,
    body: {
      instanceId: params.config.instanceId,
      ...(params.config.installId ? { installId: params.config.installId } : {}),
      ...params.request,
      agentId,
    },
  });
}
