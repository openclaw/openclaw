// Legacy generic web-fetch policy config removal for managed proxy rollout.
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const DEPRECATED_GENERIC_FETCH_CONFIG_MESSAGE =
  'Deprecated generic fetch config is accepted during this migration window, but outbound policy now belongs at the managed proxy / Proxyline boundary. Run "openclaw doctor --fix" to remove this key.';

const DEPRECATED_GENERIC_FETCH_CONFIG_PATHS = [
  ["tools", "web", "fetch", "maxRedirects"],
  ["tools", "web", "fetch", "ssrfPolicy"],
  ["tools", "web", "fetch", "useTrustedEnvProxy"],
  ["gateway", "http", "endpoints", "chatCompletions", "images", "maxRedirects"],
  ["gateway", "http", "endpoints", "responses", "files", "maxRedirects"],
  ["gateway", "http", "endpoints", "responses", "images", "maxRedirects"],
] as const;

function formatConfigPath(path: readonly string[]): string {
  return path.join(".");
}

function removeConfigPath(raw: Record<string, unknown>, path: readonly string[]): boolean {
  const parentPath = path.slice(0, -1);
  const key = path[path.length - 1];
  if (!key) {
    return false;
  }

  let parent: Record<string, unknown> = raw;
  for (const part of parentPath) {
    const next = getRecord(parent[part]);
    if (!next) {
      return false;
    }
    parent = next;
  }

  if (!Object.hasOwn(parent, key)) {
    return false;
  }
  delete parent[key];
  return true;
}

const DEPRECATED_GENERIC_FETCH_CONFIG_RULES: LegacyConfigRule[] =
  DEPRECATED_GENERIC_FETCH_CONFIG_PATHS.map((path) => ({
    path: [...path],
    message: DEPRECATED_GENERIC_FETCH_CONFIG_MESSAGE,
    requireSourceLiteral: true,
  }));

/** Legacy config migration specs for deprecated generic web-fetch policy config. */
export const LEGACY_CONFIG_MIGRATIONS_WEB_FETCH: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "generic-fetch-policy-config-remove",
    describe: "Remove deprecated generic fetch policy keys now owned by managed proxy policy",
    legacyRules: DEPRECATED_GENERIC_FETCH_CONFIG_RULES,
    apply: (raw, changes) => {
      for (const path of DEPRECATED_GENERIC_FETCH_CONFIG_PATHS) {
        if (!removeConfigPath(raw, path)) {
          continue;
        }
        changes.push(`Removed deprecated ${formatConfigPath(path)}.`);
      }
    },
  }),
];
