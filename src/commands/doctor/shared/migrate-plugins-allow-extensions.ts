// Doctor migration: seed plugins.allow from installed extension directories when no allowlist exists.
import path from "node:path";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizePluginsConfig } from "../../../plugins/config-state.js";
import { listInstalledPluginDirs } from "../../../security/installed-plugin-dirs.js";

function hasExplicitPluginsAllow(cfg: OpenClawConfig): boolean {
  return cfg.plugins != null && Object.hasOwn(cfg.plugins, "allow");
}

/**
 * When extension artifacts exist under the state directory but the operator has
 * not pinned an explicit plugins.allow, seed the allowlist with the discovered
 * installed plugin ids. This prevents post-upgrade hosts from immediately
 * landing in a security-audit critical/warn state.
 *
 * Explicit operator-defined allowlists, denylists, and disabled entries are
 * preserved and never overwritten by this migration.
 */
export async function maybeMigratePluginsAllowForExtensions(params: {
  cfg: OpenClawConfig;
  stateDir: string;
}): Promise<{ config: OpenClawConfig; changes: string[] }> {
  const cfg = params.cfg;
  if (hasExplicitPluginsAllow(cfg)) {
    return { config: cfg, changes: [] };
  }

  const normalizedPlugins = normalizePluginsConfig(cfg.plugins);
  if (!normalizedPlugins.enabled) {
    return { config: cfg, changes: [] };
  }

  const { pluginDirs } = await listInstalledPluginDirs({ stateDir: params.stateDir });
  if (pluginDirs.length === 0) {
    return { config: cfg, changes: [] };
  }

  const denySet = new Set(normalizedPlugins.deny.map((id) => id.toLowerCase()));
  const disabled = new Set<string>();
  for (const [id, entry] of Object.entries(normalizedPlugins.entries)) {
    if (entry?.enabled === false) {
      disabled.add(id.toLowerCase());
    }
  }

  const allowIds = pluginDirs
    .map((dir) => path.basename(dir))
    .filter((id) => !denySet.has(id.toLowerCase()) && !disabled.has(id.toLowerCase()))
    .toSorted((a, b) => a.localeCompare(b, "en"));

  if (allowIds.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next: OpenClawConfig = {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: allowIds,
    },
  };

  const changeNote =
    allowIds.length === 1
      ? `Set plugins.allow to ["${allowIds[0]}"] because extension artifacts exist but no allowlist was configured.`
      : `Set plugins.allow to [${allowIds.map((id) => `"${id}"`).join(", ")}] because extension artifacts exist but no allowlist was configured.`;

  return { config: next, changes: [changeNote] };
}
