import type { OpenClawConfig } from "../../../config/types.js";
import {
  applyPluginDoctorCompatibilityMigrations,
  collectRelevantDoctorPluginIds,
} from "../../../plugins/doctor-contract-registry.js";

export function applyChannelDoctorCompatibilityMigrations(cfg: Record<string, unknown>): {
  next: Record<string, unknown>;
  changes: string[];
} {
  const compat = applyPluginDoctorCompatibilityMigrations(cfg as OpenClawConfig, {
    pluginIds: collectRelevantDoctorPluginIds(cfg),
  });
  return {
    next: compat.config as OpenClawConfig & Record<string, unknown>,
    changes: compat.changes,
  };
}
