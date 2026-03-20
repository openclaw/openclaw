import { isSensitiveConfigPath } from "../config/schema.hints.js";
import type { RbacRole } from "./types.js";

const HIDDEN_PLACEHOLDER = "[Hidden — admin access required]";

/**
 * Filter a flat config value (single key/path) for a given role.
 * Returns the original value for admins, or `undefined` / placeholder for non-admins
 * when the path is sensitive.
 *
 * @returns `{ value, hidden }` — `hidden` is true when the value was redacted.
 */
export function filterConfigValue(params: { path: string; value: unknown; role: RbacRole }): {
  value: unknown;
  hidden: boolean;
} {
  const { path, value, role } = params;
  if (role === "admin") {
    return { value, hidden: false };
  }
  const sensitive = isSensitiveConfigPath(path);
  if (!sensitive) {
    return { value, hidden: false };
  }
  return { value: HIDDEN_PLACEHOLDER, hidden: true };
}

/**
 * Recursively redact sensitive fields in a config object for a non-admin role.
 *
 * Only walks top-level keys whose dot-path is flagged as sensitive.
 * Designed for config display (e.g. `config show`).
 */
export function redactConfigForRole(params: {
  config: Record<string, unknown>;
  role: RbacRole;
  pathPrefix?: string;
}): Record<string, unknown> {
  if (params.role === "admin") {
    return params.config;
  }

  const { config, role, pathPrefix = "" } = params;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (isSensitiveConfigPath(path)) {
      result[key] = HIDDEN_PLACEHOLDER;
      continue;
    }
    if (Array.isArray(value)) {
      const arrayPath = `${path}[]`;
      result[key] = value.map((item) => {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          return redactConfigForRole({
            config: item as Record<string, unknown>,
            role,
            pathPrefix: arrayPath,
          });
        }
        return item;
      });
    } else if (value !== null && typeof value === "object") {
      result[key] = redactConfigForRole({
        config: value as Record<string, unknown>,
        role,
        pathPrefix: path,
      });
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Check whether the current role can write to a config path.
 * Only admins can write config values.
 */
export function canWriteConfig(role: RbacRole): boolean {
  return role === "admin";
}

/**
 * Check whether the current role can read a sensitive config path.
 */
export function canReadSensitiveConfig(role: RbacRole): boolean {
  return role === "admin";
}
