// Doctor config-flow steps for legacy compatibility and unknown-key cleanup.
import { isDeepStrictEqual } from "node:util";
import { restoreEnvVarRefsFromResolved } from "../../../config/env-preserve.js";
import { projectAuthoredAgentRosterForWrite } from "../../../config/io.write-prepare.js";
import { formatConfigIssueLines } from "../../../config/issue-format.js";
import { createMergePatch } from "../../../config/merge-patch.js";
import { cloneConfigWithResolutionFacts } from "../../../config/resolution-facts.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import { protectActiveAuthProfileConfig } from "../../doctor-auth-profile-config.js";
import { stripUnknownConfigKeys } from "../../doctor-config-analysis.js";
import type { DoctorConfigMutationState } from "./config-mutation-state.js";
import {
  classifyOtelGrpcMigrationOwnership,
  containsAuthoredInclude,
} from "./include-migration-ownership.js";
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
  const collect = (authored: unknown, resolved: unknown): void => {
    if (typeof authored === "string" && /\$\{[A-Z_][A-Z0-9_]*\}/.test(authored)) {
      if (values.has(authored) && !isDeepStrictEqual(values.get(authored), resolved)) {
        ambiguous.add(authored);
      }
      values.set(authored, resolved);
    } else if (authored && typeof authored === "object") {
      for (const [key, value] of Object.entries(authored)) {
        collect(
          value,
          resolved && typeof resolved === "object"
            ? (resolved as Record<string, unknown>)[key] // SAFETY: non-null object; indexed values remain unknown.
            : undefined,
        );
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
          retain(
            value,
            resolved && typeof resolved === "object"
              ? (resolved as Record<string, unknown>)[key] // SAFETY: non-null object; indexed values remain unknown.
              : undefined,
          ),
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
  const unchanged = restoreEnvVarRefsFromResolved(
    candidate,
    canonicalAuthored,
    canonicalResolved,
    explicitSetPaths,
  );
  const context = { authoredRaw: source.parsed, resolvedRaw: source.resolved };
  const migratedAuthored = applyLegacyDoctorMigrations(canonicalAuthored, {
    sourceConfigBeforeMigrations: source.resolved,
    context,
  });
  const migratedResolved = applyLegacyDoctorMigrations(canonicalResolved, {
    sourceConfigBeforeMigrations: source.resolved,
    context,
  });
  // Only migration-owned destinations participate in the second pass. Unchanged policy
  // templates must not restore retired IDs after their resolved values were canonicalized.
  const referenceTemplate = createMergePatch(
    canonicalAuthored,
    migratedAuthored.next ?? canonicalAuthored,
  );
  const resolvedTemplate = createMergePatch(
    canonicalResolved,
    migratedResolved.next ?? canonicalResolved,
  );
  const restored = restoreEnvVarRefsFromResolved(
    unchanged,
    retainValuePreservingMigrationRefs(referenceTemplate, resolvedTemplate, source),
    resolvedTemplate,
    explicitSetPaths,
  );
  // SAFETY: Restoring string leaves preserves the candidate's config structure.
  return restored as OpenClawConfig;
}
