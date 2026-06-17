// Legacy provider runtime config migrations for plugin ids and bundled discovery policy.
import {
  defineLegacyConfigMigration,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { isRecord, type JsonRecord } from "./legacy-config-record-shared.js";
import { migrateLegacyXSearchConfig } from "./legacy-x-search-migrate.js";

const LEGACY_OPENAI_CODEX_PLUGIN_ID = "openai-codex";
const OPENAI_PLUGIN_ID = "openai";

const BUNDLED_DISCOVERY_COMPAT_RULE: LegacyConfigRule = {
  path: ["plugins", "allow"],
  message:
    'plugins.allow now gates bundled provider discovery by default; run "openclaw doctor --fix" to preserve legacy bundled provider compatibility as plugins.bundledDiscovery="compat", or set plugins.bundledDiscovery="allowlist" to keep the stricter behavior.',
  requireSourceLiteral: true,
  match: (value, root) => {
    if (!Array.isArray(value) || value.length === 0) {
      return false;
    }
    const plugins = isRecord(root.plugins) ? root.plugins : undefined;
    return plugins?.bundledDiscovery === undefined;
  },
};

const X_SEARCH_RULE: LegacyConfigRule = {
  path: ["tools", "web", "x_search", "apiKey"],
  message:
    'tools.web.x_search.apiKey moved to the xAI plugin; use plugins.entries.xai.config.webSearch.apiKey instead. Run "openclaw doctor --fix".',
};

function rewritePluginIdList(value: unknown): { next: unknown; changed: boolean } {
  if (!Array.isArray(value)) {
    return { next: value, changed: false };
  }
  let changed = false;
  const seen = new Set<string>();
  const next: unknown[] = [];
  for (const entry of value) {
    const replacement = entry === LEGACY_OPENAI_CODEX_PLUGIN_ID ? OPENAI_PLUGIN_ID : entry;
    if (replacement !== entry) {
      changed = true;
    }
    if (typeof replacement === "string") {
      if (seen.has(replacement)) {
        changed = true;
        continue;
      }
      seen.add(replacement);
    }
    next.push(replacement);
  }
  return { next, changed };
}

function rewritePluginSlots(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  let changed = false;
  for (const [slot, pluginId] of Object.entries(value)) {
    if (pluginId === LEGACY_OPENAI_CODEX_PLUGIN_ID) {
      value[slot] = OPENAI_PLUGIN_ID;
      changed = true;
    }
  }
  return changed;
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => areJsonValuesEqual(entry, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) {
      return false;
    }
    const leftKeys = Object.keys(left).toSorted();
    const rightKeys = Object.keys(right).toSorted();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) => key === rightKeys[index] && areJsonValuesEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function deepMergePluginEntry(
  existing: JsonRecord,
  legacy: JsonRecord,
  path: string[] = ["plugins", "entries", OPENAI_PLUGIN_ID],
): { merged: JsonRecord; conflicts: string[] } {
  const merged = { ...existing };
  const conflicts: string[] = [];
  for (const key of Object.keys(legacy)) {
    const legacyVal = legacy[key];
    const existingVal = merged[key];
    if (!(key in merged)) {
      merged[key] = legacyVal;
    } else if (isRecord(existingVal) && isRecord(legacyVal)) {
      const nested = deepMergePluginEntry(existingVal, legacyVal, [...path, key]);
      merged[key] = nested.merged;
      conflicts.push(...nested.conflicts);
    } else if (!areJsonValuesEqual(existingVal, legacyVal)) {
      conflicts.push([...path, key].join("."));
    }
    // When canonical already has a conflicting key, it wins (no overwrite).
  }
  return { merged, conflicts };
}

type PluginEntriesRewriteResult =
  | { kind: "unchanged" }
  | { kind: "rewritten" }
  | { kind: "merged"; conflicts: string[] };

function rewritePluginEntries(value: unknown): PluginEntriesRewriteResult {
  if (!isRecord(value) || !(LEGACY_OPENAI_CODEX_PLUGIN_ID in value)) {
    return { kind: "unchanged" };
  }
  if (!(OPENAI_PLUGIN_ID in value)) {
    value[OPENAI_PLUGIN_ID] = value[LEGACY_OPENAI_CODEX_PLUGIN_ID];
    delete value[LEGACY_OPENAI_CODEX_PLUGIN_ID];
    return { kind: "rewritten" };
  }

  const existing = value[OPENAI_PLUGIN_ID];
  const legacy = value[LEGACY_OPENAI_CODEX_PLUGIN_ID];
  let conflicts: string[] = [];
  if (isRecord(existing) && isRecord(legacy)) {
    const merged = deepMergePluginEntry(existing, legacy);
    value[OPENAI_PLUGIN_ID] = merged.merged;
    conflicts = merged.conflicts;
  } else if (!areJsonValuesEqual(existing, legacy)) {
    conflicts = ["plugins.entries.openai"];
  } else {
    value[OPENAI_PLUGIN_ID] = existing;
  }
  delete value[LEGACY_OPENAI_CODEX_PLUGIN_ID];
  return { kind: "merged", conflicts };
}

function rewriteLegacyOpenAICodexPluginPolicy(raw: Record<string, unknown>): string[] {
  const plugins = isRecord(raw.plugins) ? raw.plugins : undefined;
  if (!plugins) {
    return [];
  }
  const changes: string[] = [];
  for (const key of ["allow", "deny"] as const) {
    const rewritten = rewritePluginIdList(plugins[key]);
    if (rewritten.changed) {
      plugins[key] = rewritten.next;
      changes.push(`Rewrote plugins.${key} openai-codex references to openai.`);
    }
  }
  const entriesRewrite = rewritePluginEntries(plugins.entries);
  if (entriesRewrite.kind === "rewritten") {
    changes.push("Rewrote plugins.entries.openai-codex to plugins.entries.openai.");
  } else if (entriesRewrite.kind === "merged") {
    changes.push("Merged plugins.entries.openai-codex into plugins.entries.openai.");
    if (entriesRewrite.conflicts.length > 0) {
      changes.push(
        `plugins.entries.openai-codex had conflicting values already set on plugins.entries.openai; kept plugins.entries.openai values and review manually: ${entriesRewrite.conflicts.join(", ")}.`,
      );
    }
  }
  if (rewritePluginSlots(plugins.slots)) {
    changes.push("Rewrote plugins.slots openai-codex references to openai.");
  }
  return changes;
}

/** Legacy config migration specs for provider/plugin runtime config compatibility. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_PROVIDERS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "plugins.openai-codex->plugins.openai",
    describe: "Rewrite retired OpenAI Codex plugin policy ids",
    legacyRules: [
      {
        path: ["plugins"],
        message:
          'plugins.openai-codex references are retired; use the openai plugin id. Run "openclaw doctor --fix".',
        requireSourceLiteral: true,
        match: (_value, root) =>
          rewriteLegacyOpenAICodexPluginPolicy(structuredClone(root)).length > 0,
      },
    ],
    apply: (raw, changes) => {
      changes.push(...rewriteLegacyOpenAICodexPluginPolicy(raw));
    },
  }),
  defineLegacyConfigMigration({
    id: "plugins.allow->plugins.bundledDiscovery.compat",
    describe: "Preserve bundled provider discovery for existing restrictive allowlists",
    legacyRules: [BUNDLED_DISCOVERY_COMPAT_RULE],
    apply: (raw, changes) => {
      const plugins = isRecord(raw.plugins) ? raw.plugins : undefined;
      if (!plugins || plugins.bundledDiscovery !== undefined) {
        return;
      }
      const allow = plugins.allow;
      if (!Array.isArray(allow) || allow.length === 0) {
        return;
      }
      plugins.bundledDiscovery = "compat";
      changes.push(
        'Set plugins.bundledDiscovery="compat" to preserve legacy bundled provider discovery for this restrictive plugins.allow config.',
      );
    },
  }),
  defineLegacyConfigMigration({
    id: "tools.web.x_search.apiKey->plugins.entries.xai.config.webSearch.apiKey",
    describe: "Move legacy x_search auth into the xAI plugin webSearch config",
    legacyRules: [X_SEARCH_RULE],
    apply: (raw, changes) => {
      const migrated = migrateLegacyXSearchConfig(raw);
      if (!migrated.changes.length) {
        return;
      }
      for (const key of Object.keys(raw)) {
        delete raw[key];
      }
      Object.assign(raw, migrated.config);
      changes.push(...migrated.changes);
    },
  }),
];
