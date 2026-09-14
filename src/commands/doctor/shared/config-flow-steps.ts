// Doctor config-flow steps for legacy compatibility and unknown-key cleanup.
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { restoreEnvVarRefsFromResolved } from "../../../config/env-preserve.js";
import { coerceConfig } from "../../../config/io.read-helpers.js";
import { projectAuthoredAgentRosterForWrite } from "../../../config/io.write-prepare.js";
import { formatConfigIssueLines } from "../../../config/issue-format.js";
import { createMergePatch } from "../../../config/merge-patch.js";
import { cloneConfigWithResolutionFacts } from "../../../config/resolution-facts.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import { migratePluginConfigId } from "../../../plugins/update-config.js";
import { protectActiveAuthProfileConfig } from "../../doctor-auth-profile-config.js";
import { stripUnknownConfigKeys } from "../../doctor-config-analysis.js";
import type { DoctorConfigMutationState } from "./config-mutation-state.js";
import {
  classifyOtelGrpcMigrationOwnership,
  containsAuthoredInclude,
} from "./include-migration-ownership.js";
import type { InstalledPluginIdRecovery } from "./installed-plugin-id-recovery.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

/** Apply legacy config migrations and update preview/fix state for doctor config flow. */
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
  if (otelOwnership) {
    const ownership = otelOwnership;
    if (ownership.kind === "manual") {
      const otelPath = "diagnostics.otel.protocol";
      const targets =
        ownership.targetPaths.length > 0
          ? ` Inspect these candidate source files and remove or replace ${otelPath} = "grpc" from every definition: ${ownership.targetPaths.join(", ")}.`
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
  }
  const hasAuthoredIncludes = containsAuthoredInclude(params.snapshot.parsed);
  // State repairs must inspect resolved paths, not literal env templates.
  const {
    config: migrated,
    sourceConfig: migratedSource,
    changes,
    partiallyValid,
  } = migrateLegacyConfig(params.snapshot.sourceConfig, {
    authoredRaw: params.snapshot.parsed,
    resolvedRaw: params.snapshot.sourceConfig,
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
    issueLines,
    changeLines: changes,
    partiallyValid: partiallyValid === true ? true : undefined,
  };
}

/** Strip unknown config keys while preserving active auth profile settings. */
export function applyUnknownConfigKeyStep(params: {
  state: DoctorConfigMutationState;
  shouldRepair: boolean;
  doctorFixCommand: string;
}): {
  state: DoctorConfigMutationState;
  removed: string[];
  repairs: string[];
  warnings: string[];
} {
  const unknown = stripUnknownConfigKeys(params.state.candidate);
  if (unknown.removed.length === 0) {
    return { state: params.state, removed: [], repairs: [], warnings: [] };
  }
  const protectedAuth = protectActiveAuthProfileConfig({
    before: params.state.candidate,
    after: unknown.config,
  });

  return {
    state: {
      cfg: params.shouldRepair ? protectedAuth.config : params.state.cfg,
      candidate: protectedAuth.config,
      pendingChanges: true,
      fixHints: params.shouldRepair
        ? params.state.fixHints
        : [...params.state.fixHints, `Run "${params.doctorFixCommand}" to remove these keys.`],
    },
    removed: unknown.removed,
    repairs: protectedAuth.repairs,
    warnings: protectedAuth.warnings,
  };
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

/** Restore unchanged and moved references without substituting a later environment. */
export function restoreDoctorConfigEnvRefs(
  candidate: OpenClawConfig,
  source: DoctorConfigReferenceSource | undefined,
  appliedPluginIdMigrations?: Readonly<Record<string, string>>,
): OpenClawConfig {
  if (!source) {
    return candidate;
  }
  // Both views use the original resolved roster identity, including escaped-id facts.
  const canonicalAuthored = projectAuthoredAgentRosterForWrite({
    rootAuthoredConfig: source.authored,
    sourceConfigBeforeMigrations: source.resolved,
  });
  const canonicalResolved = projectAuthoredAgentRosterForWrite({
    rootAuthoredConfig: source.resolved,
    sourceConfigBeforeMigrations: source.resolved,
  });
  const unchanged = restoreEnvVarRefsFromResolved(candidate, canonicalAuthored, canonicalResolved);
  const context = { authoredRaw: source.parsed, resolvedRaw: source.resolved };
  const migratedAuthored = applyLegacyDoctorMigrations(canonicalAuthored, context);
  const migratedResolved = applyLegacyDoctorMigrations(canonicalResolved, context);
  const authoredView = migratedAuthored.next ?? canonicalAuthored;
  const resolvedView = migratedResolved.next ?? canonicalResolved;
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
  const restored = restoreEnvVarRefsFromResolved(unchanged, referenceTemplate, resolvedTemplate);
  let movedAuthored = migratedAuthoredConfig;
  let movedResolved = migratedResolvedConfig;
  const pluginIdMigrations = new Map(Object.entries(appliedPluginIdMigrations ?? {}));
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
  );
  // SAFETY: Restoring string leaves preserves the candidate's config structure.
  return recovered as OpenClawConfig;
}
