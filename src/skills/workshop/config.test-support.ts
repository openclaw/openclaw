import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Adds Workshop settings at the plugin's own config path, marked as already migrated. */
export function workshopPluginConfig(
  settings: Record<string, unknown>,
  base: OpenClawConfig = {},
): OpenClawConfig {
  return {
    ...base,
    plugins: {
      ...base.plugins,
      entries: { ...base.plugins?.entries, "skill-workshop": { config: settings } },
    },
    meta: { ...base.meta, migrations: { ...base.meta?.migrations, skillWorkshopPlugin: true } },
  };
}
