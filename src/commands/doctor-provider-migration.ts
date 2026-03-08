/**
 * Doctor step: detect and migrate deprecated provider references in config.
 *
 * When a model provider is removed (e.g., google-antigravity → google-gemini-cli),
 * all config references (models, crons, heartbeats, failover chains, aliases) break.
 * This module detects stale provider references and offers to migrate them.
 *
 * @see https://github.com/openclaw/openclaw/issues/26476
 */

import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

/**
 * Registry of deprecated providers and their successors.
 * Add new entries here when a provider is removed.
 */
export const DEPRECATED_PROVIDER_MAP: Record<string, string> = {
  "google-antigravity": "google-gemini-cli",
};

/**
 * Recursively find and replace deprecated provider references in a config object.
 * Returns the number of replacements made.
 */
export function migrateProviderRefs(
  obj: unknown,
  oldProvider: string,
  newProvider: string,
  changes: string[],
  path = "",
): number {
  if (obj === null || obj === undefined) {
    return 0;
  }

  let count = 0;

  if (typeof obj === "string") {
    // This is handled by the parent (object key/value replacement)
    return 0;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const item = obj[i];
      if (typeof item === "string") {
        if (item.startsWith(`${oldProvider}/`)) {
          const newValue = item.replace(`${oldProvider}/`, `${newProvider}/`);
          obj[i] = newValue;
          changes.push(`${path}[${i}]: ${item} → ${newValue}`);
          count++;
        } else if (item === oldProvider) {
          obj[i] = newProvider;
          changes.push(`${path}[${i}]: ${item} → ${newProvider}`);
          count++;
        } else if (item.startsWith(`${oldProvider}:`)) {
          const newValue = item.replace(oldProvider, newProvider);
          obj[i] = newValue;
          changes.push(`${path}[${i}]: ${item} → ${newValue}`);
          count++;
        }
      } else if (typeof item === "object") {
        count += migrateProviderRefs(item, oldProvider, newProvider, changes, `${path}[${i}]`);
      }
    }
    return count;
  }

  if (typeof obj === "object") {
    const record = obj as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const currentPath = path ? `${path}.${key}` : key;
      const value = record[key];

      // Check if the key itself contains the old provider (e.g., model alias keys)
      if (key.startsWith(`${oldProvider}/`)) {
        const newKey = key.replace(`${oldProvider}/`, `${newProvider}/`);
        record[newKey] = record[key];
        delete record[key];
        changes.push(`${currentPath} (key): ${key} → ${newKey}`);
        count++;
        count += migrateProviderRefs(
          record[newKey],
          oldProvider,
          newProvider,
          changes,
          path ? `${path}.${newKey}` : newKey,
        );
        continue;
      }

      // Check if the key matches the old provider exactly (e.g., auth profile keys)
      if (key === oldProvider || key.startsWith(`${oldProvider}:`)) {
        const newKey = key.replace(oldProvider, newProvider);
        record[newKey] = record[key];
        delete record[key];
        changes.push(`${currentPath} (key): ${key} → ${newKey}`);
        count++;
        count += migrateProviderRefs(
          record[newKey],
          oldProvider,
          newProvider,
          changes,
          path ? `${path}.${newKey}` : newKey,
        );
        continue;
      }

      // Check string values
      if (typeof value === "string") {
        if (value.startsWith(`${oldProvider}/`)) {
          const newValue = value.replace(`${oldProvider}/`, `${newProvider}/`);
          record[key] = newValue;
          changes.push(`${currentPath}: ${value} → ${newValue}`);
          count++;
        } else if (value === oldProvider) {
          record[key] = newProvider;
          changes.push(`${currentPath}: ${value} → ${newProvider}`);
          count++;
        }
      } else if (typeof value === "object") {
        count += migrateProviderRefs(value, oldProvider, newProvider, changes, currentPath);
      }
    }
  }

  return count;
}

/**
 * Detect deprecated provider references in the config.
 * Returns a map of deprecated providers found and the number of references.
 */
export function detectDeprecatedProviders(cfg: Record<string, unknown>): Map<string, number> {
  const found = new Map<string, number>();
  const configStr = JSON.stringify(cfg);

  for (const oldProvider of Object.keys(DEPRECATED_PROVIDER_MAP)) {
    // Count occurrences of the old provider in the serialized config
    const regex = new RegExp(oldProvider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    const matches = configStr.match(regex);
    if (matches && matches.length > 0) {
      found.set(oldProvider, matches.length);
    }
  }

  return found;
}

/**
 * Doctor step: detect and offer to migrate deprecated provider references.
 */
export async function maybeRepairDeprecatedProviders(
  cfg: OpenClawConfig,
  prompter: DoctorPrompter,
): Promise<OpenClawConfig> {
  const deprecated = detectDeprecatedProviders(cfg);

  if (deprecated.size === 0) {
    return cfg;
  }

  const lines: string[] = [];
  for (const [oldProvider, count] of deprecated) {
    const newProvider = DEPRECATED_PROVIDER_MAP[oldProvider];
    lines.push(
      `- ${count} reference(s) to removed provider "${oldProvider}" found.`,
      `  Successor: "${newProvider}"`,
    );
  }
  lines.push("");
  lines.push("These references will cause errors until migrated.");

  note(lines.join("\n"), "Deprecated provider references");

  const shouldMigrate = await prompter.confirmRepair({
    message: "Migrate deprecated provider references now?",
    initialValue: true,
  });

  if (!shouldMigrate) {
    return cfg;
  }

  // Deep clone to avoid mutating the original
  const migrated = structuredClone(cfg);
  const allChanges: string[] = [];

  for (const [oldProvider, _count] of deprecated) {
    const newProvider = DEPRECATED_PROVIDER_MAP[oldProvider];
    migrateProviderRefs(migrated, oldProvider, newProvider, allChanges);
  }

  if (allChanges.length > 0) {
    const summary =
      allChanges.length <= 10
        ? allChanges.join("\n")
        : `${allChanges.slice(0, 10).join("\n")}\n... and ${allChanges.length - 10} more`;
    note(`Migrated ${allChanges.length} reference(s):\n${summary}`, "Provider migration complete");
  }

  return migrated;
}
