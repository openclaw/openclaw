import { isDeepStrictEqual } from "node:util";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../../../packages/terminal-core/src/note.js";
import {
  getDeferredPluginMigrationConfigFacts,
  setDeferredPluginMigrationConfigFacts,
} from "../../../config/deferred-plugin-migration-config.js";
import { restoreEnvVarRefsFromResolved } from "../../../config/env-preserve.js";
import { coerceConfig } from "../../../config/io.read-helpers.js";
import { projectAuthoredAgentRosterForWrite } from "../../../config/io.write-prepare.js";
import { formatConfigIssueLines } from "../../../config/issue-format.js";
import { createMergePatch } from "../../../config/merge-patch.js";
import { cloneConfigWithResolutionFacts } from "../../../config/resolution-facts.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolvePluginDoctorProviderRenames } from "../../../plugins/doctor-contract-registry.js";
import { migratePluginConfigId } from "../../../plugins/update-config.js";
import { protectActiveAuthProfileConfig } from "../../doctor-auth-profile-config.js";
import { stripUnknownConfigKeys } from "../../doctor-config-analysis.js";
import {
  applyDoctorConfigMutation,
  type DoctorConfigMutationState,
} from "./config-mutation-state.js";
import {
  classifyOtelGrpcMigrationOwnership,
  containsAuthoredInclude,
} from "./include-migration-ownership.js";
import type { InstalledPluginIdRecovery } from "./installed-plugin-id-recovery.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";
import { applyProviderRenames, planProviderRenames } from "./provider-rename.js";

export function applyLegacyCompatibilityStep(params: {
  snapshot: ConfigFileSnapshot;
  state: DoctorConfigMutationState;
  shouldRepair: boolean;
  doctorFixCommand: string;
}): {
  state: DoctorConfigMutationState;
  issueLines: string[];
  changeLines: string[];
  partiallyValid?: boolean;
  blocksWrite?: boolean;
} {
  if (params.snapshot.legacyIssues.length === 0) {
    return {
      state: params.state,
      issueLines: [],
      changeLines: [],
    };
  }

  const issueLines = formatConfigIssueLines(params.snapshot.legacyIssues, "-");
  const otelOwnership = classifyOtelGrpcMigrationOwnership({
    snapshot: params.snapshot,
    authoredConfig: params.snapshot.parsed,
    resolvedConfig: params.snapshot.sourceConfig,
  });
  if (otelOwnership?.kind === "manual") {
    const otelPath = "diagnostics.otel.protocol";
    const targets =
      otelOwnership.targetPaths.length > 0
        ? ` Inspect these candidate source files and remove or replace ${otelPath} = "grpc" from every definition: ${otelOwnership.targetPaths.join(", ")}.`
        : ` Remove or replace ${otelPath} = "grpc" in the owning $include directive or included file.`;
    return {
      state: params.state,
      issueLines: [
        ...issueLines,
        `- ${otelPath}: Doctor cannot safely rewrite this $include ownership.${targets} No config files were changed.`,
      ],
      changeLines: [],
      blocksWrite: true,
    };
  }
  const hasAuthoredIncludes = containsAuthoredInclude(params.snapshot.parsed);
  // State repairs must inspect resolved paths, not literal env templates.
  const {
    config: migrated,
    sourceConfig: migratedSource,
    changes,
    warnings,
    partiallyValid,
  } = migrateLegacyConfig(params.snapshot.sourceConfig, {
    sourceConfigBeforeMigrations: params.snapshot.sourceConfigBeforeMigrations,
    context: {
      authoredRaw: params.snapshot.parsed,
      resolvedRaw: params.snapshot.sourceConfig,
    },
  });
  const migrationCandidate = migratedSource ?? migrated;
  // Read-time normalization still needs persistence; unresolved advice alone does not.
  const hasLegacyChanges =
    changes.length > 0 ||
    !isDeepStrictEqual(
      params.snapshot.sourceConfigBeforeMigrations ??
        (hasAuthoredIncludes ? params.snapshot.sourceConfig : params.snapshot.parsed),
      params.snapshot.sourceConfig,
    );

  return {
    state: {
      // Keep migrated previews in memory; confirmation controls persistence.
      // Safe partial repairs still commit when unrelated validation issues remain.
      ...params.state,
      ...(migrationCandidate ? { cfg: migrationCandidate, candidate: migrationCandidate } : {}),
      pendingChanges: params.state.pendingChanges || hasLegacyChanges,
      fixHints:
        params.shouldRepair || !hasLegacyChanges
          ? params.state.fixHints
          : [
              ...params.state.fixHints,
              `Run "${params.doctorFixCommand}" to ${partiallyValid ? "finish fixing" : "migrate"} legacy config keys.`,
            ],
    },
    issueLines: [...issueLines, ...(warnings ?? [])],
    changeLines: changes,
    partiallyValid: partiallyValid === true ? true : undefined,
  };
}

/** Retire heartbeat data before removing unknown configuration keys. */
export async function applyRetiredConfigStep(params: {
  state: DoctorConfigMutationState;
  shouldRepair: boolean;
  doctorFixCommand: string;
  sourceConfig: OpenClawConfig;
  emitChanges: (changeLines: readonly string[]) => void;
  preflight?: {
    heartbeatMigrationDeferred?: true;
    cronStoreSelectionUnresolved?: true;
  };
}): Promise<DoctorConfigMutationState> {
  let state = params.state;
  if (params.preflight?.heartbeatMigrationDeferred) {
    return state;
  }
  if (params.shouldRepair && !params.preflight?.cronStoreSelectionUnresolved) {
    const { tryProjectRetiredHeartbeatConfig } = await import("../../doctor-heartbeat-legacy.js");
    const { retireHeartbeatWithDoctor } = await import("../../doctor-heartbeat-retirement.js");
    const retiredConfig = tryProjectRetiredHeartbeatConfig(state.candidate)
      ? await retireHeartbeatWithDoctor(state.candidate)
      : undefined;
    if (retiredConfig && JSON.stringify(retiredConfig) !== JSON.stringify(state.candidate)) {
      const mutation = {
        config: retiredConfig,
        changes: ["Retired heartbeat configuration after ordinary automation data was verified."],
      };
      params.emitChanges(mutation.changes);
      state = applyDoctorConfigMutation({
        state,
        mutation,
        shouldRepair: params.shouldRepair,
        fixHint: `Run "${params.doctorFixCommand}" to finish the heartbeat migration.`,
      });
    }
  }

  const unknown = stripUnknownConfigKeys(
    state.candidate,
    getDeferredPluginMigrationConfigFacts(params.sourceConfig)?.flatMap((pending) =>
      (pending.configPaths ?? []).concat(pending.validationExcludedPaths ?? []),
    ),
  );
  if (unknown.removed.length === 0) {
    return state;
  }
  const protectedAuth = protectActiveAuthProfileConfig({
    before: state.candidate,
    after: unknown.config,
  });
  state = applyDoctorConfigMutation({
    state,
    mutation: { config: protectedAuth.config, changes: unknown.removed },
    shouldRepair: params.shouldRepair,
    fixHint: `Run "${params.doctorFixCommand}" to remove these keys.`,
  });
  const lines = [
    ...unknown.removed.map((pathLocal) => `- ${pathLocal}`),
    ...protectedAuth.repairs.map((change) => `- ${change}`),
  ];
  if (params.shouldRepair) {
    params.emitChanges(lines);
  } else {
    note(lines.join("\n"), "Unknown config keys");
  }
  if (protectedAuth.warnings.length > 0) {
    note(protectedAuth.warnings.join("\n"), "Doctor warnings");
  }
  return state;
}

export type DoctorConfigReferenceSource = {
  authored: OpenClawConfig;
  resolved: OpenClawConfig;
  parsed: unknown;
  installedPluginIdRecovery?: InstalledPluginIdRecovery;
};

/** Keep the matched planning read independent of later write receipts and environment changes. */
export function prepareDoctorConfigReferenceSource(
  snapshot: ConfigFileSnapshot,
): DoctorConfigReferenceSource | undefined {
  if (!snapshot.authoredConfig || !snapshot.sourceConfigBeforeMigrations) {
    return undefined;
  }
  return {
    authored: structuredClone(snapshot.authoredConfig),
    resolved: cloneConfigWithResolutionFacts(snapshot.sourceConfigBeforeMigrations),
    parsed: structuredClone(snapshot.parsed),
  };
}

/** A moved template must still have its original read-time value after migration. */
function retainValuePreservingMigrationRefs(
  template: unknown,
  migratedResolved: unknown,
  source: DoctorConfigReferenceSource,
): unknown {
  const values = new Map<string, unknown>();
  const ambiguous = new Set<string>();
  const resolvedEntry = (resolved: unknown, key: string): unknown =>
    asOptionalObjectRecord(resolved)?.[key];
  const collect = (authored: unknown, resolved: unknown): void => {
    if (typeof authored === "string" && /\$\{[A-Z_][A-Z0-9_]*\}/.test(authored)) {
      if (values.has(authored) && !isDeepStrictEqual(values.get(authored), resolved)) {
        ambiguous.add(authored);
      }
      values.set(authored, resolved);
    } else if (authored && typeof authored === "object") {
      for (const [key, value] of Object.entries(authored)) {
        collect(value, resolvedEntry(resolved, key));
      }
    }
  };
  collect(source.authored, source.resolved);
  const retain = (authored: unknown, resolved: unknown): unknown => {
    if (typeof authored === "string" && /\$\{[A-Z_][A-Z0-9_]*\}/.test(authored)) {
      // Exact template text identifies its read-time substitution, including escapes
      // and composite strings. Never infer an environment from a resolved substring.
      return values.has(authored) &&
        !ambiguous.has(authored) &&
        isDeepStrictEqual(values.get(authored), resolved)
        ? authored
        : undefined;
    }
    if (Array.isArray(authored)) {
      return authored.map((value, index) =>
        retain(value, Array.isArray(resolved) ? resolved[index] : undefined),
      );
    }
    if (authored && typeof authored === "object") {
      return Object.fromEntries(
        Object.entries(authored).map(([key, value]) => [
          key,
          retain(value, resolvedEntry(resolved, key)),
        ]),
      );
    }
    return authored;
  };
  return retain(template, migratedResolved);
}

/** Restore unchanged and moved references without substituting a later environment. */
export function restoreDoctorConfigEnvRefs(
  candidate: OpenClawConfig,
  source: DoctorConfigReferenceSource | undefined,
  explicitSetPaths?: readonly (readonly string[])[],
  migrationOptions: {
    appliedPluginIdMigrations?: Readonly<Record<string, string>>;
  } = {},
): OpenClawConfig {
  if (!source) {
    return candidate;
  }
  // Both views use the original resolved roster identity, including escaped-id facts.
  const projectRoster = (rootAuthoredConfig: OpenClawConfig) =>
    projectAuthoredAgentRosterForWrite({
      rootAuthoredConfig,
      sourceConfigBeforeMigrations: source.resolved,
    });
  const canonicalAuthored = coerceConfig(projectRoster(source.authored));
  const canonicalResolved = coerceConfig(projectRoster(source.resolved));
  const unchanged = restoreEnvVarRefsFromResolved(
    candidate,
    canonicalAuthored,
    canonicalResolved,
    explicitSetPaths,
  );
  const options = {
    sourceConfigBeforeMigrations: source.resolved,
    context: { authoredRaw: source.parsed, resolvedRaw: source.resolved },
  };
  // Replay the resolved routing decision on authored templates before plugin cleanup.
  const providerRenames = planProviderRenames(
    canonicalResolved,
    resolvePluginDoctorProviderRenames({ config: canonicalResolved }),
  );
  const authoredProviderConfig = applyProviderRenames(canonicalAuthored, providerRenames).config;
  const migratedAuthored = applyLegacyDoctorMigrations(authoredProviderConfig, options);
  const resolvedProviderConfig = applyProviderRenames(canonicalResolved, providerRenames).config;
  const migratedResolved = applyLegacyDoctorMigrations(resolvedProviderConfig, options);
  const authoredView = migratedAuthored.next ?? authoredProviderConfig;
  const resolvedView = migratedResolved.next ?? resolvedProviderConfig;
  if (!isRecord(authoredView) || !isRecord(resolvedView)) {
    throw new Error("Doctor reference migrations must preserve config object roots.");
  }
  // Snapshot records and roster/legacy projections keep object roots. Use the
  // reader's structural typing without resolving or validating raw reference leaves.
  const migratedAuthoredConfig = coerceConfig(authoredView);
  const migratedResolvedConfig = coerceConfig(resolvedView);
  // Only migration-owned destinations participate in the second pass. Unchanged policy
  // templates must not restore retired IDs after their resolved values were canonicalized.
  const referenceTemplate = createMergePatch(canonicalAuthored, migratedAuthoredConfig);
  const resolvedTemplate = createMergePatch(canonicalResolved, migratedResolvedConfig);
  const restored = restoreEnvVarRefsFromResolved(
    unchanged,
    retainValuePreservingMigrationRefs(referenceTemplate, resolvedTemplate, source),
    resolvedTemplate,
    explicitSetPaths,
  );
  let movedAuthored = migratedAuthoredConfig;
  let movedResolved = migratedResolvedConfig;
  const pluginIdMigrations = new Map(
    Object.entries(migrationOptions.appliedPluginIdMigrations ?? {}),
  );
  for (const [legacyId, owner] of source.installedPluginIdRecovery ?? []) {
    pluginIdMigrations.set(legacyId, owner.pluginId);
  }
  for (const [legacyId, pluginId] of pluginIdMigrations) {
    movedAuthored = migratePluginConfigId(movedAuthored, legacyId, pluginId);
    movedResolved = migratePluginConfigId(movedResolved, legacyId, pluginId);
  }
  // Only moved entry destinations carry templates. Policy IDs are canonical values,
  // even when the old allow/deny/slot was authored through an environment reference.
  const pluginReferences = createMergePatch(
    migratedAuthoredConfig.plugins?.entries ?? {},
    movedAuthored.plugins?.entries ?? {},
  );
  const pluginValues = createMergePatch(
    migratedResolvedConfig.plugins?.entries ?? {},
    movedResolved.plugins?.entries ?? {},
  );
  const recovered = restoreEnvVarRefsFromResolved(
    restored,
    { plugins: { entries: pluginReferences } },
    { plugins: { entries: pluginValues } },
    explicitSetPaths,
  );
  if (!isRecord(recovered)) {
    throw new Error("Doctor reference restoration must preserve the config object root.");
  }
  const recoveredConfig = coerceConfig(recovered);
  setDeferredPluginMigrationConfigFacts(
    recoveredConfig,
    getDeferredPluginMigrationConfigFacts(candidate),
  );
  return recoveredConfig;
}
