// Top-level legacy config migration runner used before full config validation.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { inheritLegacyDefaultAgentId } from "../../../config/legacy.default-agent-owner.js";
import type { LegacyConfigMigrationContext } from "../../../config/legacy.shared.js";
import { cloneConfigWithResolutionFacts } from "../../../config/resolution-facts.js";
import { isPluginSourceModulePath } from "../../../plugins/native-module-require.js";
import { getCachedPluginModuleLoader } from "../../../plugins/plugin-module-loader-cache.js";
import { applyChannelDoctorCompatibilityMigrations } from "./channel-legacy-config-migrate.js";
import { LEGACY_CONFIG_MIGRATIONS } from "./legacy-config-migrations.js";

const require = createRequire(import.meta.url);

// Recovery also migrates synchronously. Load repair machinery only when a full
// migration runs, leaving config readers and the extracted PR wrapper lightweight.
function loadBindingRepair(): typeof import("./legacy-config-binding-repair.runtime.js") {
  const source = isPluginSourceModulePath(fileURLToPath(import.meta.url));
  const modulePath = fileURLToPath(
    new URL(
      source
        ? "./legacy-config-binding-repair.runtime.ts"
        : "./legacy-config-binding-repair.runtime.js",
      import.meta.url,
    ),
  );
  const loaded: unknown = source
    ? getCachedPluginModuleLoader({ modulePath, importerUrl: import.meta.url, tryNative: false })(
        modulePath,
      )
    : require(modulePath);
  // SAFETY: Both fixed targets expose the same typed repair owner.
  return loaded as typeof import("./legacy-config-binding-repair.runtime.js");
}

export type LegacyDoctorMigrationOptions = {
  /** Original include/env-resolved source, or explicitly unavailable. Never the normalized roster. */
  sourceConfigBeforeMigrations: unknown;
  context?: LegacyConfigMigrationContext;
  // State-free previews skip plugin contracts; the committed result always uses a full run.
  pluginContracts?: boolean;
};

/** Apply all legacy doctor migrations to raw config, returning null when nothing changed. */
export function applyLegacyDoctorMigrations(
  raw: unknown,
  options: LegacyDoctorMigrationOptions,
): {
  next: Record<string, unknown> | null;
  changes: string[];
  warnings?: string[];
} {
  if (!raw || typeof raw !== "object") {
    return { next: null, changes: [] };
  }
  const original = raw as Record<string, unknown>;
  const next = cloneConfigWithResolutionFacts(original);
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS) {
    migration.apply(next, changes, options.context);
  }
  const compat = applyChannelDoctorCompatibilityMigrations(next, {
    pluginContracts: options.pluginContracts !== false,
  });
  changes.push(...compat.changes);
  const ownership: ReturnType<
    typeof import("./legacy-config-binding-repair.runtime.js").repairUnownedChannelAccountBindings
  > =
    options.pluginContracts !== false
      ? loadBindingRepair().repairUnownedChannelAccountBindings({
          config: compat.next,
          sourceConfigBeforeMigrations: options.sourceConfigBeforeMigrations,
        })
      : { config: compat.next, changes: [] };
  changes.push(...ownership.changes);
  // The config reader keeps the retired default-agent marker outside the object.
  // Cloning must retain that owner so validation does not roll back a repairable roster.
  return {
    next: changes.length > 0 ? inheritLegacyDefaultAgentId(original, ownership.config) : null,
    changes,
    ...(ownership.warnings?.length ? { warnings: ownership.warnings } : {}),
  };
}
