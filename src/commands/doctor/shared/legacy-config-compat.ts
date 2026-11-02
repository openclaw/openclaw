// Top-level legacy config migration runner used before full config validation.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  inheritLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "../../../config/legacy.default-agent-owner.js";
import type { LegacyConfigMigrationContext } from "../../../config/legacy.shared.js";
import {
  cloneConfigWithResolutionFacts,
  copyConfigResolutionFactsThroughRewrite,
} from "../../../config/resolution-facts.js";
import { materializeLegacyAgentOwnershipForActiveChannelsResult } from "../../../config/validation.js";
import {
  isPluginSourceModulePath,
  tryNativeRequireModule,
} from "../../../plugins/native-module-require.js";
import { getCachedPluginModuleLoader } from "../../../plugins/plugin-module-loader-cache.js";
import { preparePluginLoaderAliases } from "../../../plugins/sdk-alias.js";
import { applyChannelDoctorCompatibilityMigrations } from "./channel-legacy-config-migrate.js";
import { resolveChannelAccountBindingRepairInput } from "./legacy-config-binding-repair-input.js";
import { LEGACY_CONFIG_MIGRATIONS } from "./legacy-config-migrations.js";
import { collectToolPolicyConflictWarnings } from "./legacy-config-migrations.runtime.tool-policy-conflicts.js";
import { migrateLegacyContextBudgetConfig } from "./legacy-context-budget.js";
import { removeLegacyCopilotDiscovery } from "./legacy-copilot-discovery.js";

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
  // Host repairs share native module owners; unsupported source loaders keep the transform path.
  const native = source
    ? tryNativeRequireModule(modulePath, {
        aliasMap: preparePluginLoaderAliases({ modulePath, moduleUrl: import.meta.url })
          .resolveAlias,
      })
    : undefined;
  const loaded: unknown = native?.ok
    ? native.moduleExport
    : source
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
  if (!isRecord(raw)) {
    return { next: null, changes: [] };
  }
  const original = raw;
  const copilotConfig = removeLegacyCopilotDiscovery(original);
  const contextBudget = migrateLegacyContextBudgetConfig(copilotConfig);
  const next = inheritLegacyDefaultAgentId(
    original,
    cloneConfigWithResolutionFacts(contextBudget.config),
  );
  const changes = contextBudget.changes.map(({ message }) => message);
  if (copilotConfig !== original) {
    changes.push(
      "The GitHub Copilot discovery switch was retired and has been removed. Configured Copilot access now refreshes its model list automatically. Use the model allow list (agents.defaults.modelPolicy.allow) to hide Copilot models; it does not stop discovery requests.",
    );
  }
  for (const migration of LEGACY_CONFIG_MIGRATIONS) {
    migration.apply(next, changes, options.context);
  }
  const compat = applyChannelDoctorCompatibilityMigrations(next, {
    pluginContracts: options.pluginContracts !== false,
  });
  changes.push(...compat.changes);
  const legacyOwner = tryGetLegacyDefaultAgentId(next);
  if (legacyOwner && options.pluginContracts !== false) {
    const materialized = materializeLegacyAgentOwnershipForActiveChannelsResult(
      compat.next,
      legacyOwner,
    );
    if (materialized.insertedPaths.length > 0) {
      Object.assign(compat.next, materialized.config);
      changes.push("Preserved legacy ownership for enabled channels.");
    }
  }
  const ownership: ReturnType<
    typeof import("./legacy-config-binding-repair.runtime.js").repairUnownedChannelAccountBindings
  > =
    options.pluginContracts !== false && resolveChannelAccountBindingRepairInput(compat.next)
      ? loadBindingRepair().repairUnownedChannelAccountBindings({
          config: compat.next,
          sourceConfigBeforeMigrations: options.sourceConfigBeforeMigrations,
        })
      : { config: compat.next, changes: [] };
  changes.push(...ownership.changes);
  const warnings = [
    ...contextBudget.warnings.map(({ message }) => message),
    ...(compat.warnings ?? []),
    ...(ownership.warnings ?? []),
    ...collectToolPolicyConflictWarnings(ownership.config),
  ];
  copyConfigResolutionFactsThroughRewrite(original, ownership.config);
  // Only Doctor retains the preimage owner for state migration before the config commit.
  return {
    next: changes.length > 0 ? inheritLegacyDefaultAgentId(next, ownership.config) : null,
    changes,
    ...(warnings.length ? { warnings } : {}),
  };
}
