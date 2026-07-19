// Resolves durable runtime mode and worker settings from config with env overrides.
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { DurableRuntimeConfig, DurableRuntimeMode } from "../config/types.durable.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DEFAULT_DURABLE_WORKER_POLL_INTERVAL_MS = 1000;
const DEFAULT_DURABLE_WORKER_CLAIM_TTL_MS = 5 * 60 * 1000;
const DEFAULT_DURABLE_WORKER_MAX_CONCURRENCY = 1;
const DEFAULT_DURABLE_INPUT_PREVIEW_CHARS = 600;
const DEFAULT_DURABLE_INPUT_FULL_MAX_CHARS = 16_384;

function parsePositiveInteger(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function configuredDurableRuntime(): DurableRuntimeConfig | undefined {
  return getRuntimeConfigSnapshot()?.durable;
}

export function resolveDurableRuntimeMode(
  env: NodeJS.ProcessEnv = process.env,
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): DurableRuntimeMode {
  if (env.OPENCLAW_DURABLE_RUNTIME !== undefined || env.OPENCLAW_DURABLE_WORKER !== undefined) {
    const runtimeEnabled = ENABLED_VALUES.has(
      (env.OPENCLAW_DURABLE_RUNTIME ?? "").trim().toLowerCase(),
    );
    if (!runtimeEnabled) {
      return "off";
    }
    return ENABLED_VALUES.has((env.OPENCLAW_DURABLE_WORKER ?? "").trim().toLowerCase())
      ? "authority"
      : "observe";
  }
  return config?.mode ?? "off";
}

export function isDurableRuntimeEnabled(
  env: NodeJS.ProcessEnv = process.env,
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): boolean {
  return resolveDurableRuntimeMode(env, config) !== "off";
}

export function isDurableWorkerEnabled(
  env: NodeJS.ProcessEnv = process.env,
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): boolean {
  return resolveDurableRuntimeMode(env, config) === "authority";
}

export function isDurableAuthorityEnabled(
  env: NodeJS.ProcessEnv = process.env,
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): boolean {
  return isDurableWorkerEnabled(env, config);
}

export function isDurableObservationEnabled(
  env: NodeJS.ProcessEnv = process.env,
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): boolean {
  return isDurableRuntimeEnabled(env, config) && !isDurableAuthorityEnabled(env, config);
}

export function resolveDurableWorkerPollIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): number {
  return (
    parsePositiveInteger(env.OPENCLAW_DURABLE_WORKER_POLL_INTERVAL_MS) ??
    config?.worker?.pollIntervalMs ??
    DEFAULT_DURABLE_WORKER_POLL_INTERVAL_MS
  );
}

export function resolveDurableWorkerClaimTtlMs(
  env: NodeJS.ProcessEnv = process.env,
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): number {
  return (
    parsePositiveInteger(env.OPENCLAW_DURABLE_WORKER_CLAIM_TTL_MS) ??
    config?.worker?.claimTtlMs ??
    DEFAULT_DURABLE_WORKER_CLAIM_TTL_MS
  );
}

export function resolveDurableWorkerMaxConcurrency(
  env: NodeJS.ProcessEnv = process.env,
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): number {
  return (
    parsePositiveInteger(env.OPENCLAW_DURABLE_WORKER_MAX_CONCURRENCY) ??
    config?.worker?.maxConcurrency ??
    DEFAULT_DURABLE_WORKER_MAX_CONCURRENCY
  );
}

export function resolveDurableInputTextPolicy(
  env: NodeJS.ProcessEnv = process.env,
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): "metadata" | "preview" | "full" {
  const raw = env.OPENCLAW_DURABLE_INPUT_TEXT?.trim().toLowerCase();
  if (raw === "full" || raw === "inline") {
    return "full";
  }
  if (raw === "metadata" || raw === "preview") {
    return raw;
  }
  return config?.input?.text ?? "preview";
}

export function resolveDurableInputPreviewChars(
  env: NodeJS.ProcessEnv = process.env,
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): number {
  return (
    parseNonNegativeInteger(env.OPENCLAW_DURABLE_INPUT_PREVIEW_CHARS) ??
    config?.input?.previewChars ??
    DEFAULT_DURABLE_INPUT_PREVIEW_CHARS
  );
}

export function resolveDurableInputFullMaxChars(
  env: NodeJS.ProcessEnv = process.env,
  config: DurableRuntimeConfig | undefined = configuredDurableRuntime(),
): number {
  return (
    parsePositiveInteger(env.OPENCLAW_DURABLE_INPUT_FULL_MAX_CHARS) ??
    config?.input?.fullMaxChars ??
    DEFAULT_DURABLE_INPUT_FULL_MAX_CHARS
  );
}

export function resolveDurableRuntimeSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveOpenClawStateSqlitePath(env);
}
