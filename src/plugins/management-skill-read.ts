import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readPluginSkill } from "../skills/loading/plugin-skills.js";
import { withManagedPluginCache } from "./management-catalog.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import { resolveManagedPluginMetadata } from "./management-service.js";

export const readManagedPluginSkill = withManagedPluginCache(
  async (params: {
    config: OpenClawConfig;
    pluginId: string;
    skillName: string;
    path?: string;
    version?: string;
    env?: NodeJS.ProcessEnv;
  }) => {
    const metadata = resolveManagedPluginMetadata(params.config, params.env ?? process.env);
    const manifest = metadata.byPluginId.get(metadata.normalizePluginId(params.pluginId));
    if (!manifest) {
      throw new ManagedPluginLifecycleError("Installed plugin not found.");
    }
    return readPluginSkill(manifest, params.skillName, params);
  },
);
