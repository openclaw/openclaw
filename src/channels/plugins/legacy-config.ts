import type { LegacyConfigRule } from "../../config/legacy.shared.js";
import type { OpenClawConfig } from "../../config/types.js";
import { listBootstrapChannelPlugins } from "./bootstrap-registry.js";

export function collectChannelLegacyConfigRules(): LegacyConfigRule[] {
  return listBootstrapChannelPlugins().flatMap((plugin) => plugin.doctor?.legacyConfigRules ?? []);
}

export function applyChannelDoctorCompatibilityMigrations(cfg: Record<string, unknown>): {
  next: Record<string, unknown>;
  changes: string[];
} {
  let nextCfg = cfg as OpenClawConfig & Record<string, unknown>;
  const changes: string[] = [];
  for (const plugin of listBootstrapChannelPlugins()) {
    const mutation = plugin.doctor?.normalizeCompatibilityConfig?.({ cfg: nextCfg });
    if (!mutation || mutation.changes.length === 0) {
      continue;
    }
    nextCfg = mutation.config as OpenClawConfig & Record<string, unknown>;
    changes.push(...mutation.changes);
  }
  return { next: nextCfg, changes };
}
