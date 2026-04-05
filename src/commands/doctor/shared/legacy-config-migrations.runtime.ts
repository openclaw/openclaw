import type { LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_AGENTS } from "./legacy-config-migrations.runtime.agents.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY } from "./legacy-config-migrations.runtime.gateway.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_PROVIDERS } from "./legacy-config-migrations.runtime.providers.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS } from "./legacy-config-migrations.runtime.tts.js";

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME: LegacyConfigMigrationSpec[] = [
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_AGENTS,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_PROVIDERS,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS,
];
