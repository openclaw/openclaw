import type { OpenClawConfig } from "../../../config/types.js";
import { applyPluginDoctorCompatibilityMigrations } from "../../../plugins/doctor-contract-registry.js";
import { isRecord } from "./legacy-config-record-shared.js";

function collectRelevantDoctorChannelIds(raw: unknown): string[] {
  const channels = isRecord(raw) && isRecord(raw.channels) ? raw.channels : null;
  if (!channels) {
    return [];
  }
  return Object.keys(channels)
    .filter((channelId) => channelId !== "defaults")
    .toSorted();
}

export function applyChannelDoctorCompatibilityMigrations(cfg: Record<string, unknown>): {
  next: Record<string, unknown>;
  changes: string[];
} {
  const compat = applyPluginDoctorCompatibilityMigrations(cfg as OpenClawConfig, {
    pluginIds: collectRelevantDoctorChannelIds(cfg),
  });
  return {
    next: compat.config as OpenClawConfig & Record<string, unknown>,
    changes: compat.changes,
  };
}
