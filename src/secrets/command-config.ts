/** Collects and analyzes command-scoped secret assignments from OpenClaw config. */
import { getAuthoredConfigSecretRef, resolveConfigSecretRef } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseSecretRef } from "../config/types.secrets.js";
import { getPath } from "./path-utils.js";
import { isExpectedResolvedSecretValue } from "./secret-value.js";
import { discoverConfigSecretTargetsByIds } from "./target-registry.js";

/** One command config path whose value can be resolved from a SecretRef. */
export type CommandSecretAssignment = {
  path: string;
  pathSegments: string[];
  value: unknown;
};

/** Active or inactive command target that could not be materialized. */
export type UnresolvedCommandSecretAssignment = Omit<CommandSecretAssignment, "value">;

/** Analyzes command secret assignments without mutating the source config. */
export function analyzeCommandSecretAssignmentsFromSnapshot(params: {
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  targetIds: ReadonlySet<string>;
  inactiveRefPaths?: ReadonlySet<string>;
  allowedPaths?: ReadonlySet<string>;
}) {
  const defaults = params.sourceConfig.secrets?.defaults;
  const assignments: CommandSecretAssignment[] = [];
  const diagnostics: string[] = [];
  const unresolved: UnresolvedCommandSecretAssignment[] = [];
  const inactive: UnresolvedCommandSecretAssignment[] = [];

  for (const target of discoverConfigSecretTargetsByIds(params.sourceConfig, params.targetIds)) {
    if (params.allowedPaths && !params.allowedPaths.has(target.path)) {
      continue;
    }
    const inlineCandidateRef = resolveConfigSecretRef({
      config: params.sourceConfig,
      path: target.path,
      value: target.value,
      defaults,
    });
    const explicitRef = parseSecretRef(target.refValue, defaults);
    const ref = explicitRef ?? inlineCandidateRef;
    if (!ref) {
      continue;
    }

    const resolved = getPath(params.resolvedConfig, target.pathSegments);
    if (
      getAuthoredConfigSecretRef(params.resolvedConfig, target.path) ||
      !isExpectedResolvedSecretValue(resolved, target.entry.expectedResolvedValue)
    ) {
      // Inactive surfaces are diagnostics, not hard failures; active unresolved refs block the
      // command because the runtime snapshot promised that target was usable.
      if (params.inactiveRefPaths?.has(target.path)) {
        diagnostics.push(
          `${target.path}: secret ref is configured on an inactive surface; skipping command-time assignment.`,
        );
        inactive.push({
          path: target.path,
          pathSegments: [...target.pathSegments],
        });
        continue;
      }
      unresolved.push({
        path: target.path,
        pathSegments: [...target.pathSegments],
      });
      continue;
    }

    assignments.push({
      path: target.path,
      pathSegments: [...target.pathSegments],
      value: resolved,
    });

    const hasCompetingSiblingRef =
      target.entry.secretShape === "sibling_ref" && explicitRef && inlineCandidateRef; // pragma: allowlist secret
    if (hasCompetingSiblingRef) {
      // Sibling refs are the canonical target for these surfaces; inline refs are legacy overlap.
      diagnostics.push(
        `${target.path}: both inline and sibling ref were present; sibling ref took precedence.`,
      );
    }
  }

  return { assignments, diagnostics, unresolved, inactive };
}
