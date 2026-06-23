import {
  expandEnvNormalizationKeys,
  normalizeZaiEnv,
  resolveEnvNormalizationKeys,
} from "../infra/env.js";
// Defines environment-variable config metadata and preservation rules.
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import { containsEnvVarReference } from "./env-substitution.js";
import { ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV } from "./future-version-guard.js";
import type { OpenClawConfig } from "./types.js";

function isBlockedConfigEnvVar(key: string): boolean {
  return (
    key.toUpperCase() === ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV ||
    key.toUpperCase() === "OPENCLAW_INCLUDE_ROOTS" ||
    isDangerousHostEnvVarName(key) ||
    isDangerousHostEnvOverrideVarName(key)
  );
}

/** Returns whether a config-controlled environment entry is safe to apply at runtime. */
export function isConfigRuntimeEnvVarAllowed(key: string, value: string): boolean {
  return Boolean(value.trim()) && !isBlockedConfigEnvVar(key) && !containsEnvVarReference(value);
}

function collectConfigEnvVarsByTarget(cfg?: OpenClawConfig): Record<string, string> {
  const envConfig = cfg?.env;
  if (!envConfig) {
    return {};
  }

  const entries: Record<string, string> = {};

  if (envConfig.vars) {
    for (const [rawKey, value] of Object.entries(envConfig.vars)) {
      if (typeof value !== "string" || !value.trim()) {
        continue;
      }
      const key = normalizeEnvVarKey(rawKey, { portable: true });
      if (!key) {
        continue;
      }
      if (!isConfigRuntimeEnvVarAllowed(key, value)) {
        continue;
      }
      entries[key] = value;
    }
  }

  for (const [rawKey, value] of Object.entries(envConfig)) {
    if (rawKey === "shellEnv" || rawKey === "vars") {
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key) {
      continue;
    }
    if (!isConfigRuntimeEnvVarAllowed(key, value)) {
      continue;
    }
    entries[key] = value;
  }

  return entries;
}

function findCaseInsensitiveEnvKey(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (Object.hasOwn(env, key)) {
    return key;
  }
  const upperKey = key.toUpperCase();
  return Object.keys(env).find((candidate) => candidate.toUpperCase() === upperKey);
}

export function cloneEnvWithPlatformSemantics(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cloned = { ...env } as NodeJS.ProcessEnv;
  if (process.platform !== "win32") {
    return cloned;
  }
  // A plain spread loses Windows process.env's case-insensitive lookup and assignment semantics.
  return new Proxy(cloned, {
    deleteProperty(target, property) {
      if (typeof property !== "string") {
        return Reflect.deleteProperty(target, property);
      }
      const key = findCaseInsensitiveEnvKey(target, property);
      return key ? Reflect.deleteProperty(target, key) : true;
    },
    get(target, property, receiver) {
      if (typeof property !== "string") {
        return Reflect.get(target, property, receiver);
      }
      const key = findCaseInsensitiveEnvKey(target, property);
      return key ? target[key] : Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      if (typeof property !== "string") {
        return Reflect.getOwnPropertyDescriptor(target, property);
      }
      const key = findCaseInsensitiveEnvKey(target, property);
      if (!key) {
        return undefined;
      }
      return {
        configurable: true,
        enumerable: true,
        value: target[key],
        writable: true,
      };
    },
    has(target, property) {
      return typeof property === "string"
        ? findCaseInsensitiveEnvKey(target, property) !== undefined
        : Reflect.has(target, property);
    },
    set(target, property, value) {
      if (typeof property !== "string") {
        return Reflect.set(target, property, value);
      }
      target[findCaseInsensitiveEnvKey(target, property) ?? property] = value as string | undefined;
      return true;
    },
  });
}

/** Collects config env vars safe to inject into runtime process environments. */
export function collectConfigRuntimeEnvVars(cfg?: OpenClawConfig): Record<string, string> {
  return collectConfigEnvVarsByTarget(cfg);
}

/** Collects config env vars safe to persist into managed service environments. */
export function collectConfigServiceEnvVars(cfg?: OpenClawConfig): Record<string, string> {
  // Runtime and service envs intentionally share filtering until a target-specific contract exists.
  return collectConfigEnvVarsByTarget(cfg);
}

/** Builds a cloned environment with config env vars applied without mutating the base env. */
export function createConfigRuntimeEnv(
  cfg: OpenClawConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = cloneEnvWithPlatformSemantics(baseEnv);
  applyConfigEnvVars(cfg, env);
  return env;
}

/** Applies config env vars to an environment without overwriting existing non-empty values. */
export function applyConfigEnvVars(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    lowerPrecedenceEnv?: Readonly<Record<string, string>>;
    onLowerPrecedenceKeysReplaced?: (keys: readonly string[]) => void;
  } = {},
): void {
  const entries = collectConfigRuntimeEnvVars(cfg);
  const lowerPrecedenceEntries = Object.entries(options.lowerPrecedenceEnv ?? {});
  const normalizeKey = (key: string) => (process.platform === "win32" ? key.toUpperCase() : key);
  const lowerPrecedenceEnv = new Map(
    lowerPrecedenceEntries.map(([key, value]) => [normalizeKey(key), value]),
  );
  const configEnvKeys = expandEnvNormalizationKeys(Object.keys(entries));
  const configValuesByKey = new Map<string, Set<string>>();
  for (const [key, value] of Object.entries(entries)) {
    for (const normalizedKey of resolveEnvNormalizationKeys(key)) {
      const values = configValuesByKey.get(normalizedKey) ?? new Set<string>();
      values.add(value);
      configValuesByKey.set(normalizedKey, values);
    }
  }
  const higherPrecedenceValues = new Map<string, string>();
  for (const key of Object.keys(entries)) {
    const normalizedKeys = resolveEnvNormalizationKeys(key);
    const winningValue = normalizedKeys
      .map((normalizedKey) => [normalizedKey, env[normalizedKey]] as const)
      .find(
        ([normalizedKey, currentValue]) =>
          currentValue?.trim() &&
          lowerPrecedenceEnv.get(normalizedKey) !== currentValue &&
          !configValuesByKey.get(normalizedKey)?.has(currentValue),
      )?.[1];
    if (winningValue !== undefined) {
      for (const normalizedKey of normalizedKeys) {
        higherPrecedenceValues.set(normalizedKey, winningValue);
      }
    }
  }
  const replacedLowerPrecedenceKeys: string[] = [];
  for (const [key, value] of lowerPrecedenceEntries) {
    if (configEnvKeys.has(normalizeKey(key)) && env[key] === value) {
      delete env[key];
      replacedLowerPrecedenceKeys.push(key);
    }
  }
  if (replacedLowerPrecedenceKeys.length > 0) {
    options.onLowerPrecedenceKeysReplaced?.(replacedLowerPrecedenceKeys);
  }
  for (const [key, value] of Object.entries(entries)) {
    const higherPrecedenceValue = higherPrecedenceValues.get(normalizeKey(key));
    if (higherPrecedenceValue !== undefined) {
      env[key] = higherPrecedenceValue;
      continue;
    }
    const currentValue = env[key];
    if (currentValue?.trim() && lowerPrecedenceEnv.get(normalizeKey(key)) !== currentValue) {
      continue;
    }
    // Skip values containing unresolved ${VAR} references — applyConfigEnvVars runs
    // before env substitution, so these would pollute process.env with literal placeholders
    // (e.g. process.env.OPENCLAW_GATEWAY_TOKEN = "${VAULT_TOKEN}") which downstream auth
    // resolution would accept as valid credentials.
    if (containsEnvVarReference(value)) {
      continue;
    }
    env[key] = value;
  }
  normalizeZaiEnv(env);
}
