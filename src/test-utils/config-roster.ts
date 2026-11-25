import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_ENTRIES } from "../commands/doctor/shared/legacy-config-migrations.runtime.entries.js";
import { applyImplicitAgentRosterDefaults } from "../config/implicit-agent-roster.js";
import type { LegacyConfigMigrationContext } from "../config/legacy.shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Give runtime fixtures the canonical roster that Doctor supplies before admission. */
export function createCanonicalAgentConfigFixture(
  config: unknown = {},
  options: Pick<LegacyConfigMigrationContext, "env" | "homedir"> = {},
) {
  const next = structuredClone(config);
  if (!isRecord(next)) {
    throw new TypeError("Agent config fixture must be an object");
  }
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_ENTRIES) {
    migration.apply(next, [], { ...options, authoredRaw: config, resolvedRaw: config });
  }
  return { config: applyImplicitAgentRosterDefaults(next) as OpenClawConfig };
}
