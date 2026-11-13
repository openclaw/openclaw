import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { stripUnknownConfigKeys } from "../../doctor-config-analysis.js";
import { projectRetiredHeartbeatConfig } from "../../doctor-heartbeat-legacy.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

/**
 * Doctor's state-free config transform, applied in memory to a config an older
 * release wrote. The file stays unchanged until `openclaw doctor --fix` saves it.
 */
export function projectOlderReleaseConfig(
  raw: Record<string, unknown>,
  sourceRaw: unknown,
): { config: OpenClawConfig; changes: string[] } | undefined {
  let migrated: ReturnType<typeof applyLegacyDoctorMigrations>;
  let projected: OpenClawConfig;
  try {
    migrated = applyLegacyDoctorMigrations(raw, {
      sourceConfigBeforeMigrations: sourceRaw,
      pluginContracts: false,
    });
    projected = projectRetiredHeartbeatConfig(
      (migrated.next ?? raw) as OpenClawConfigWithLegacyRoster,
    );
  } catch {
    // A migration that refuses (for example, conflicting values) needs Doctor's own report.
    return undefined;
  }
  const stripped = stripUnknownConfigKeys(projected);
  const changes = [
    ...migrated.changes,
    ...(isDeepStrictEqual(projected, migrated.next ?? raw)
      ? []
      : ["Retired heartbeat settings are paused until Doctor converts them to automations."]),
    ...stripped.removed.map((path) => `Ignored retired key ${path}.`),
  ];
  return changes.length > 0 ? { config: stripped.config, changes } : undefined;
}
