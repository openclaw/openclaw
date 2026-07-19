// Resolves durable runtime mode and worker settings from normal OpenClaw config.
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { DurableRuntimeConfig, DurableRuntimeMode } from "../config/types.durable.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const DEFAULT_DURABLE_WORKER_POLL_INTERVAL_MS = 1000;
const DEFAULT_DURABLE_WORKER_CLAIM_TTL_MS = 5 * 60 * 1000;

function configuredDurableRuntime(): DurableRuntimeConfig | undefined {
  return getRuntimeConfigSnapshot()?.durable;
}

export function resolveDurableRuntimeMode(
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): DurableRuntimeMode {
  return config?.mode ?? "off";
}

export function isDurableRuntimeEnabled(
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): boolean {
  return resolveDurableRuntimeMode(config) !== "off";
}

export function isDurableWorkerEnabled(
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): boolean {
  return resolveDurableRuntimeMode(config) === "authority";
}

export function isDurableAuthorityEnabled(
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): boolean {
  return isDurableWorkerEnabled(config);
}

export function isDurableObservationEnabled(
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): boolean {
  return isDurableRuntimeEnabled(config) && !isDurableAuthorityEnabled(config);
}

export function resolveDurableWorkerPollIntervalMs(
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): number {
  return config?.worker?.pollIntervalMs ?? DEFAULT_DURABLE_WORKER_POLL_INTERVAL_MS;
}

export function resolveDurableWorkerClaimTtlMs(
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): number {
  return config?.worker?.claimTtlMs ?? DEFAULT_DURABLE_WORKER_CLAIM_TTL_MS;
}

export function resolveDurableRuntimeSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveOpenClawStateSqlitePath(env);
}
