// Shared Skill Workshop plugin policy migration for runtime, doctor, and config writes.
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../utils.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const SKILL_WORKSHOP_PLUGIN_ID = "skill-workshop";

function hasSkillWorkshopPluginMigrationMarker(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.meta) &&
    isRecord(value.meta.migrations) &&
    value.meta.migrations.skillWorkshopPlugin === true
  );
}

const isWorkshopId = (id: unknown) =>
  typeof id === "string" && id.trim().toLowerCase() === SKILL_WORKSHOP_PLUGIN_ID;

/**
 * Releases from 2026.10.1 ignored all `skill-workshop` plugin policy while the id was retired,
 * and Workshop ran regardless. Unmarked configs keep that outcome: policy authored before the
 * plugin returned is dropped, and an exclusive allowlist admits the plugin. Only policy that
 * also exists in `previousConfig` is stale, so a write that adds new policy keeps it.
 */
export function materializeSkillWorkshopPlugin(
  cfg: OpenClawConfig,
  previousConfig: unknown = cfg,
): { config: OpenClawConfig; changes: string[] } {
  if (hasSkillWorkshopPluginMigrationMarker(previousConfig)) {
    return { config: cfg, changes: [] };
  }
  const previous =
    isRecord(previousConfig) && isRecord(previousConfig.plugins)
      ? previousConfig.plugins
      : undefined;
  const changes: string[] = [];
  const plugins = cfg.plugins ? { ...cfg.plugins } : undefined;
  if (plugins?.entries) {
    const previousEntries = isRecord(previous?.entries) ? previous.entries : {};
    const entries = { ...plugins.entries };
    for (const id of Object.keys(entries)) {
      if (isWorkshopId(id) && isDeepStrictEqual(entries[id], previousEntries[id])) {
        delete entries[id];
        changes.push(
          `Removed plugins.entries.${id}; it was ignored while Skill Workshop was built in.`,
        );
      }
    }
    plugins.entries = entries;
  }
  const previousDeny = Array.isArray(previous?.deny) ? previous.deny : [];
  if (plugins?.deny?.some(isWorkshopId) && previousDeny.some(isWorkshopId)) {
    plugins.deny = plugins.deny.filter((id) => !isWorkshopId(id));
    changes.push(
      "Removed skill-workshop from plugins.deny; it was ignored while Skill Workshop was built in.",
    );
  }
  const previousAllow = Array.isArray(previous?.allow) ? previous.allow : [];
  if (
    plugins?.allow?.length &&
    !plugins.allow.some(isWorkshopId) &&
    previousAllow.length > 0 &&
    !previousAllow.some(isWorkshopId)
  ) {
    plugins.allow = [...plugins.allow, SKILL_WORKSHOP_PLUGIN_ID];
    changes.push(
      "Added skill-workshop to plugins.allow so Skill Workshop keeps working as a plugin.",
    );
  }
  if (plugins?.enabled === false && previous?.enabled === false) {
    changes.push(
      "plugins.enabled=false now also turns off Skill Workshop learned skills. To keep them, enable plugins and limit them with plugins.allow.",
    );
  }
  return {
    config: {
      ...cfg,
      ...(plugins ? { plugins } : {}),
      meta: { ...cfg.meta, migrations: { ...cfg.meta?.migrations, skillWorkshopPlugin: true } },
    },
    changes,
  };
}

/**
 * Runtime and validation view of an unmarked config: older `skill-workshop` policy is ignored,
 * not validated against the restored plugin's schema. Doctor removes it and records the marker.
 * Admitting the plugin through an older exclusive allowlist is Doctor's repair alone.
 */
export function projectSkillWorkshopPluginPolicy<T extends OpenClawConfig>(
  cfg: T,
): { config: T; ignored: boolean } {
  const plugins = cfg.plugins;
  if (hasSkillWorkshopPluginMigrationMarker(cfg) || !plugins) {
    return { config: cfg, ignored: false };
  }
  const entries = Object.entries(plugins.entries ?? {}).filter(([id]) => !isWorkshopId(id));
  const deny = plugins.deny?.filter((id) => !isWorkshopId(id));
  if (
    entries.length === Object.keys(plugins.entries ?? {}).length &&
    deny?.length === plugins.deny?.length
  ) {
    return { config: cfg, ignored: false };
  }
  return {
    config: {
      ...cfg,
      plugins: {
        ...plugins,
        ...(plugins.entries ? { entries: Object.fromEntries(entries) } : {}),
        ...(deny ? { deny } : {}),
      },
    },
    ignored: true,
  };
}

function readWorkshopPolicy(value: unknown) {
  const plugins = isRecord(value) && isRecord(value.plugins) ? value.plugins : {};
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  const listed = (list: unknown) => Array.isArray(list) && list.some(isWorkshopId);
  return {
    entries: Object.entries(entries).filter(([id]) => isWorkshopId(id)),
    allow: listed(plugins.allow),
    deny: listed(plugins.deny),
  };
}

/** Workshop policy the writer set or unset on request; an equal older value is not stale. */
function withoutExplicitWorkshopPolicy(
  previousConfig: unknown,
  explicitPaths: readonly (readonly string[])[],
): unknown {
  if (!isRecord(previousConfig) || !isRecord(previousConfig.plugins)) {
    return previousConfig;
  }
  const plugins = { ...previousConfig.plugins };
  for (const [root, key, id] of explicitPaths) {
    if (root !== "plugins") {
      continue;
    }
    if (key === "entries" && isWorkshopId(id) && isRecord(plugins.entries)) {
      plugins.entries = Object.fromEntries(
        Object.entries(plugins.entries).filter(([entryId]) => !isWorkshopId(entryId)),
      );
    } else if ((key === "allow" || key === "deny") && Array.isArray(plugins[key])) {
      plugins[key] = plugins[key].filter((entry: unknown) => !isWorkshopId(entry));
    }
  }
  return { ...previousConfig, plugins };
}

/**
 * A write into an older entry keeps only the settings it names; the entry's other older
 * settings were ignored and stay part of the repair. A write of the whole entry keeps it all.
 */
function keepExplicitEntryLeaves(
  cfg: OpenClawConfig,
  explicitPaths: readonly (readonly string[])[],
): OpenClawConfig {
  const entries = cfg.plugins?.entries;
  if (!entries) {
    return cfg;
  }
  let changed = false;
  const next = { ...entries };
  for (const id of Object.keys(entries).filter(isWorkshopId)) {
    const leaves = explicitPaths
      .filter(([root, key, entryId]) => root === "plugins" && key === "entries" && entryId === id)
      .map((segments) => segments.slice(3));
    if (leaves.length === 0 || leaves.some((leaf) => leaf.length === 0)) {
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const leaf of leaves) {
      let source: unknown = entries[id];
      let target = kept;
      for (const [index, segment] of leaf.entries()) {
        source = isRecord(source) ? source[segment] : undefined;
        if (source === undefined) {
          break;
        }
        if (index === leaf.length - 1) {
          target[segment] = source;
        } else {
          target = (target[segment] ??= {}) as Record<string, unknown>;
        }
      }
    }
    next[id] = kept;
    changed = true;
  }
  return changed ? { ...cfg, plugins: { ...cfg.plugins, entries: next } } : cfg;
}

/**
 * A config write records the migration when nothing older needs repair, or when the write
 * itself sets `skill-workshop` policy. Then the older policy is repaired with it, so the new
 * policy is never ignored or later removed. Other writes leave the repair to Doctor and never
 * rewrite policy lists they did not touch.
 */
export function stampSkillWorkshopPluginMigration(
  cfg: OpenClawConfig,
  previousConfig: unknown,
  explicitPaths: readonly (readonly string[])[] = [],
): OpenClawConfig {
  if (hasSkillWorkshopPluginMigrationMarker(previousConfig)) {
    return cfg;
  }
  const previous = withoutExplicitWorkshopPolicy(previousConfig, explicitPaths);
  const migrated = materializeSkillWorkshopPlugin(
    keepExplicitEntryLeaves(cfg, explicitPaths),
    previous,
  );
  const writesWorkshopPolicy = !isDeepStrictEqual(
    readWorkshopPolicy(cfg),
    readWorkshopPolicy(previous),
  );
  return migrated.changes.length === 0 || writesWorkshopPolicy ? migrated.config : cfg;
}
