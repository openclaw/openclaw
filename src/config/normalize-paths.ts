import { isPlainObject, resolveUserPath } from "../utils.js";
import type { OpenClawConfig } from "./types.js";

const PATH_VALUE_RE = /^~(?=$|[\\/])/;

const PATH_KEY_RE = /(dir|path|paths|file|root|workspace)$/i;
const PATH_LIST_KEYS = new Set(["paths", "pathPrepend"]);

function isTargetUserSandboxPath(pathKeys: readonly string[]): boolean {
  const last = pathKeys.at(-1);
  if (last !== "workspaceDir" && last !== "workspaceRoot") {
    return false;
  }
  return pathKeys.at(-2) === "user" && pathKeys.at(-3) === "sandbox";
}

function normalizeStringValue(key: string | undefined, value: string): string {
  if (!PATH_VALUE_RE.test(value.trim())) {
    return value;
  }
  if (!key) {
    return value;
  }
  if (PATH_KEY_RE.test(key) || PATH_LIST_KEYS.has(key)) {
    return resolveUserPath(value);
  }
  return value;
}

function normalizeAny(
  key: string | undefined,
  value: unknown,
  pathKeys: readonly string[],
): unknown {
  if (typeof value === "string") {
    if (isTargetUserSandboxPath(pathKeys)) {
      return value;
    }
    return normalizeStringValue(key, value);
  }

  if (Array.isArray(value)) {
    const normalizeChildren = Boolean(key && PATH_LIST_KEYS.has(key));
    return value.map((entry) => {
      if (typeof entry === "string") {
        return normalizeChildren ? normalizeStringValue(key, entry) : entry;
      }
      if (Array.isArray(entry)) {
        return normalizeAny(undefined, entry, pathKeys);
      }
      if (isPlainObject(entry)) {
        return normalizeAny(undefined, entry, pathKeys);
      }
      return entry;
    });
  }

  if (!isPlainObject(value)) {
    return value;
  }

  for (const [childKey, childValue] of Object.entries(value)) {
    const next = normalizeAny(childKey, childValue, [...pathKeys, childKey]);
    if (next !== childValue) {
      value[childKey] = next;
    }
  }

  return value;
}

/**
 * Normalize "~" paths in path-ish config fields.
 *
 * Goal: accept `~/...` consistently across config file + env overrides, while
 * keeping the surface area small and predictable.
 */
export function normalizeConfigPaths(cfg: OpenClawConfig): OpenClawConfig {
  if (!cfg || typeof cfg !== "object") {
    return cfg;
  }
  normalizeAny(undefined, cfg, []);
  return cfg;
}
