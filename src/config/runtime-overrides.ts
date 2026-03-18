import { isPlainObject } from "../utils.js";
import { parseConfigPath, setConfigValueAtPath, unsetConfigValueAtPath } from "./config-paths.js";
import { isBlockedObjectKey } from "./prototype-keys.js";
import type { OpenClawConfig } from "./types.js";

type OverrideTree = Record<string, unknown>;

let overrides: OverrideTree = {};

function sanitizeOverrideValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeOverrideValue(entry, seen));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  if (seen.has(value)) {
    return {};
  }
  seen.add(value);
  const sanitized: OverrideTree = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || isBlockedObjectKey(key)) {
      continue;
    }
    sanitized[key] = sanitizeOverrideValue(entry, seen);
  }
  seen.delete(value);
  return sanitized;
}

function mergeOverrides(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const next: OverrideTree = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || isBlockedObjectKey(key)) {
      continue;
    }
    next[key] = mergeOverrides((base as OverrideTree)[key], value);
  }
  return next;
}

export function getConfigOverrides(): OverrideTree {
  return overrides;
}

export function resetConfigOverrides(): void {
  overrides = {};
}

export function setConfigOverride(
  pathRaw: string,
  value: unknown,
): {
  ok: boolean;
  error?: string;
} {
  const parsed = parseConfigPath(pathRaw);
  if (!parsed.ok || !parsed.path) {
    return { ok: false, error: parsed.error ?? "Invalid path." };
  }
  setConfigValueAtPath(overrides, parsed.path, sanitizeOverrideValue(value));
  return { ok: true };
}

export function unsetConfigOverride(pathRaw: string): {
  ok: boolean;
  removed: boolean;
  error?: string;
} {
  const parsed = parseConfigPath(pathRaw);
  if (!parsed.ok || !parsed.path) {
    return {
      ok: false,
      removed: false,
      error: parsed.error ?? "Invalid path.",
    };
  }
  const removed = unsetConfigValueAtPath(overrides, parsed.path);
  return { ok: true, removed };
}

export function applyConfigOverrides(cfg: OpenClawConfig): OpenClawConfig {
  if (!overrides || Object.keys(overrides).length === 0) {
    return cfg;
  }
  return mergeOverrides(cfg, overrides) as OpenClawConfig;
}
