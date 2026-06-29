// Durable workflow feature flag and path resolution.
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DEFAULT_DURABLE_WORKER_POLL_INTERVAL_MS = 1000;
const DEFAULT_DURABLE_WORKER_CLAIM_TTL_MS = 5 * 60 * 1000;
const DEFAULT_DURABLE_WORKER_MAX_CONCURRENCY = 1;

function parsePositiveInteger(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function isDurableWorkflowsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ENABLED_VALUES.has((env.OPENCLAW_DURABLE_WORKFLOWS ?? "").trim().toLowerCase());
}

export function isDurableWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    isDurableWorkflowsEnabled(env) &&
    ENABLED_VALUES.has((env.OPENCLAW_DURABLE_WORKER ?? "").trim().toLowerCase())
  );
}

export function resolveDurableWorkerPollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return (
    parsePositiveInteger(env.OPENCLAW_DURABLE_WORKER_POLL_INTERVAL_MS) ??
    DEFAULT_DURABLE_WORKER_POLL_INTERVAL_MS
  );
}

export function resolveDurableWorkerClaimTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return (
    parsePositiveInteger(env.OPENCLAW_DURABLE_WORKER_CLAIM_TTL_MS) ??
    DEFAULT_DURABLE_WORKER_CLAIM_TTL_MS
  );
}

export function resolveDurableWorkerMaxConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return (
    parsePositiveInteger(env.OPENCLAW_DURABLE_WORKER_MAX_CONCURRENCY) ??
    DEFAULT_DURABLE_WORKER_MAX_CONCURRENCY
  );
}

export function resolveDurableWorkflowSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveOpenClawStateSqlitePath(env);
}
