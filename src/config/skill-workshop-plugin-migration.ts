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
 * and Workshop ran regardless. Unmarked configs keep that outcome: an entry or deny id authored
 * before the plugin returned is dropped. Only policy that also exists in `previousConfig` is
 * stale. Allowlists and the global switch are never rewritten; Doctor's health check reports
 * when they keep the plugin off.
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
  if (plugins && isRecord(plugins.entries)) {
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
  // Malformed lists stay for config validation to report.
  const previousDeny = Array.isArray(previous?.deny) ? previous.deny : [];
  if (
    plugins &&
    Array.isArray(plugins.deny) &&
    plugins.deny.some(isWorkshopId) &&
    previousDeny.some(isWorkshopId)
  ) {
    plugins.deny = plugins.deny.filter((id) => !isWorkshopId(id));
    changes.push(
      "Removed skill-workshop from plugins.deny; it was ignored while Skill Workshop was built in.",
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
 */
export function projectSkillWorkshopPluginPolicy<T extends OpenClawConfig>(
  cfg: T,
): { config: T; ignored: boolean } {
  const plugins = cfg.plugins;
  if (hasSkillWorkshopPluginMigrationMarker(cfg) || !plugins) {
    return { config: cfg, ignored: false };
  }
  const entries = Object.entries(isRecord(plugins.entries) ? plugins.entries : {}).filter(
    ([id]) => !isWorkshopId(id),
  );
  const deny = Array.isArray(plugins.deny)
    ? plugins.deny.filter((id) => !isWorkshopId(id))
    : plugins.deny;
  if (
    entries.length === Object.keys(isRecord(plugins.entries) ? plugins.entries : {}).length &&
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

/** Writes record the migration only when nothing older needs repair; Doctor owns the repair. */
export function stampSkillWorkshopPluginMigration(
  cfg: OpenClawConfig,
  previousConfig: unknown,
): OpenClawConfig {
  const migrated = materializeSkillWorkshopPlugin(cfg, previousConfig);
  return migrated.changes.length === 0 ? migrated.config : cfg;
}

/**
 * A `plugins` write against ignored older Workshop policy could be ignored or later removed by
 * Doctor, so writers refuse it with the next step instead of guessing which part is new.
 */
export function findSkillWorkshopPolicyWriteRefusal(params: {
  previousConfig: OpenClawConfig;
  nextConfig: unknown;
  writesPlugins: boolean;
}): string | undefined {
  // Doctor's repair is the write that records the marker.
  return params.writesPlugins &&
    !hasSkillWorkshopPluginMigrationMarker(params.nextConfig) &&
    projectSkillWorkshopPluginPolicy(params.previousConfig).ignored
    ? 'skill-workshop plugin policy written while Skill Workshop was built in must be migrated first. Run "openclaw doctor --fix", then retry.'
    : undefined;
}
