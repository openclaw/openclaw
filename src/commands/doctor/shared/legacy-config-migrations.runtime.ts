// Aggregated runtime legacy config migration specs across agents, gateway, models, and tools.
import type { LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_AGENTS } from "./legacy-config-migrations.runtime.agents.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_CLI_BACKENDS } from "./legacy-config-migrations.runtime.cli-backends.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON } from "./legacy-config-migrations.runtime.cron.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_DIAGNOSTICS } from "./legacy-config-migrations.runtime.diagnostics.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_ENTRIES } from "./legacy-config-migrations.runtime.entries.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY } from "./legacy-config-migrations.runtime.gateway.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP } from "./legacy-config-migrations.runtime.mcp.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS } from "./legacy-config-migrations.runtime.models.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_PROVIDERS } from "./legacy-config-migrations.runtime.providers.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";
import { LEGACY_CONFIG_MIGRATION_RUNTIME_SECRETS_EGRESS } from "./legacy-config-migrations.runtime.secrets-egress.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION } from "./legacy-config-migrations.runtime.session.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS } from "./legacy-config-migrations.runtime.skills.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SYSTEM_AGENT } from "./legacy-config-migrations.runtime.system-agent.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_TOOL_NAMES } from "./legacy-config-migrations.runtime.tool-names.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_TOOL_POLICY_CONFLICTS } from "./legacy-config-migrations.runtime.tool-policy-conflicts.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS } from "./legacy-config-migrations.runtime.tts.js";

/** Ordered runtime legacy config migrations applied by doctor. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME: LegacyConfigMigrationSpec[] = [
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_AGENTS,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_CLI_BACKENDS,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_DIAGNOSTICS,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_PROVIDERS,
  // Relocate messages.tts before cleanup inspects the canonical TTS owner.
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED,
  LEGACY_CONFIG_MIGRATION_RUNTIME_SECRETS_EGRESS,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_TOOL_NAMES,
  // Runs after the profile-bound agent repair so that owner claims its scopes first;
  // this sweeps up the remaining conflicts it declines (no profile, or profile "full").
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_TOOL_POLICY_CONFLICTS,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_ENTRIES,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_SYSTEM_AGENT,
];
