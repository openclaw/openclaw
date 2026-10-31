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
