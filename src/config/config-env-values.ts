import { resolveEnvNormalizationKeys } from "../infra/env.js";
import {
  clearFsSafeEnvFallback,
  fsSafeEnvInput,
  normalizeFsSafeNativeEnv,
} from "../infra/fs-safe-env.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import { containsEnvVarReference } from "./env-substitution.js";
import { ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV } from "./future-version-guard.js";
import type { OpenClawConfig } from "./types.js";

/** Returns whether a config-controlled environment entry is safe to apply at runtime. */
export function isConfigRuntimeEnvVarAllowed(key: string, value: string): boolean {
  const upperKey = key.toUpperCase();
  // Config cannot select host write/startup policy or publish unresolved credentials.
  return (
    Boolean(value.trim()) &&
    upperKey !== ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV &&
    upperKey !== "OPENCLAW_INCLUDE_ROOTS" &&
    upperKey !== "OPENCLAW_CONFIG_READONLY" &&
    !isDangerousHostEnvVarName(key) &&
    !isDangerousHostEnvOverrideVarName(key) &&
    !containsEnvVarReference(value)
  );
}

/** Collects config env vars safe to inject into runtime process environments. */
export function collectConfigRuntimeEnvVars(cfg?: OpenClawConfig): Record<string, string> {
  const envConfig = cfg?.env;
  if (!envConfig) {
    return {};
  }

  const entries: Record<string, string> = {};

  const candidates = [
    ...Object.entries(envConfig.vars ?? {}),
    ...Object.entries(envConfig).filter(([key]) => key !== "shellEnv" && key !== "vars"),
  ];
  for (const [rawKey, value] of candidates) {
    if (typeof value !== "string") {
      continue;
    }
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (key && isConfigRuntimeEnvVarAllowed(key, value)) {
      entries[key] = value;
    }
  }

  return entries;
}

export function findCaseInsensitiveEnvKey(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (Object.hasOwn(env, key)) {
    return key;
  }
  const upperKey = key.toUpperCase();
  return Object.keys(env).find((candidate) => candidate.toUpperCase() === upperKey);
}

export type EnvSnapshotEntry = {
  key: string;
  value: string | undefined;
};

export function envSnapshotKey(key: string): string {
  return process.platform === "win32" ? key.toUpperCase() : key;
}

export function snapshotEnvByPlatformKey(
  env: Readonly<NodeJS.ProcessEnv>,
): Map<string, EnvSnapshotEntry> {
  // Windows has one logical slot per case-insensitive key. Retain its exact spelling so
  // publication and rollback can compare-and-swap the slot without losing the original key.
  const snapshot = new Map<string, EnvSnapshotEntry>();
  for (const [key, value] of Object.entries(fsSafeEnvInput(env))) {
    const platformKey = envSnapshotKey(key);
    if (!snapshot.has(platformKey)) {
      snapshot.set(platformKey, { key, value });
    }
  }
  return snapshot;
}

export function envSnapshotEntriesEqual(
  left: EnvSnapshotEntry | undefined,
  right: EnvSnapshotEntry | undefined,
): boolean {
  return left?.key === right?.key && left?.value === right?.value;
}

export function replaceEnvSnapshotEntry(
  env: NodeJS.ProcessEnv,
  current: EnvSnapshotEntry | undefined,
  next: EnvSnapshotEntry | undefined,
): void {
  clearFsSafeEnvFallback(env);
  if (current) {
    delete env[current.key];
  }
  if (next?.value !== undefined) {
    env[next.key] = next.value;
  }
}

export function indexConfigRuntimeEnvValues(
  entries: Record<string, string>,
): Map<string, Set<string>> {
  const allowedValues = new Map<string, Set<string>>();
  for (const [key, value] of Object.entries(entries)) {
    for (const normalizedKey of resolveEnvNormalizationKeys(key)) {
      const values = allowedValues.get(normalizedKey) ?? new Set<string>();
      values.add(value);
      allowedValues.set(normalizedKey, values);
    }
  }
  return allowedValues;
}

export function snapshotEnvProperties(
  env: Readonly<NodeJS.ProcessEnv>,
): Map<string, EnvSnapshotEntry> {
  return new Map(Object.entries(fsSafeEnvInput(env)).map(([key, value]) => [key, { key, value }]));
}

export type PublishedConfigRuntimeEnvChange = {
  before: EnvSnapshotEntry | undefined;
  after: EnvSnapshotEntry | undefined;
  preparedBefore: EnvSnapshotEntry | undefined;
};

export function rollbackConfigRuntimeEnvChanges(
  env: NodeJS.ProcessEnv,
  changes: ReadonlyMap<string, PublishedConfigRuntimeEnvChange>,
): void {
  let current: ReadonlyMap<string, EnvSnapshotEntry> | undefined;
  for (const [key, change] of changes) {
    const currentEntry = (current ??= snapshotEnvByPlatformKey(env)).get(key);
    if (!envSnapshotEntriesEqual(currentEntry, change.after)) {
      continue;
    }
    replaceEnvSnapshotEntry(env, currentEntry, change.before);
  }
  normalizeFsSafeNativeEnv(env);
}
