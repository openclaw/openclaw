import { isTruthyEnvValue } from "../infra/env.js";
import { createQuantdClient, DEFAULT_QUANTD_BASE_URL } from "./client.js";
import type { QuantdSnapshot } from "./types.js";

export type QuantdRuntimeStatus = "disabled" | "ok" | "degraded" | "unreachable";

export type QuantdRuntimeSummary = {
  enabled: boolean;
  status: QuantdRuntimeStatus;
  baseUrl?: string;
  socketPath?: string;
  error?: string;
  health?: QuantdSnapshot["health"];
  wal?: QuantdSnapshot["wal"];
  replay?: QuantdSnapshot["replay"];
  metrics?: QuantdSnapshot["metrics"];
  recentEvents?: QuantdSnapshot["recentEvents"];
};

const DEFAULT_QUANTD_TIMEOUT_MS = 1_500;

function resolveQuantdPort(raw: string | undefined) {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return 19_891;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65_535) {
    return 19_891;
  }
  return parsed;
}

function resolveQuantdBaseUrlFromEnv(): string {
  const host = process.env.OPENCLAW_QUANTD_HOST?.trim() || "127.0.0.1";
  const port = resolveQuantdPort(process.env.OPENCLAW_QUANTD_PORT);
  return `http://${host}:${port}`;
}

export async function getQuantdRuntimeSummary(options?: {
  timeoutMs?: number;
}): Promise<QuantdRuntimeSummary> {
  if (!isTruthyEnvValue(process.env.OPENCLAW_QUANTD_ENABLED)) {
    return {
      enabled: false,
      status: "disabled",
    };
  }

  const socketPath = process.env.OPENCLAW_QUANTD_SOCKET_PATH?.trim() || undefined;
  const baseUrl = socketPath ? undefined : resolveQuantdBaseUrlFromEnv();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_QUANTD_TIMEOUT_MS;

  try {
    const client = createQuantdClient({
      baseUrl: baseUrl ?? DEFAULT_QUANTD_BASE_URL,
      socketPath,
      timeoutMs,
    });
    const snapshot = await client.snapshot();
    return {
      enabled: true,
      status: snapshot.health.status === "ok" ? "ok" : "degraded",
      baseUrl,
      socketPath,
      health: snapshot.health,
      wal: snapshot.wal,
      replay: snapshot.replay,
      metrics: snapshot.metrics,
      recentEvents: snapshot.recentEvents,
    };
  } catch (error) {
    return {
      enabled: true,
      status: "unreachable",
      baseUrl,
      socketPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
