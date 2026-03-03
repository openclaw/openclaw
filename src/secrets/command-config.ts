import type { OpenClawConfig } from "../config/config.js";
import { coerceSecretRef, resolveSecretInputRef } from "../config/types.secrets.js";
import { getPath } from "./path-utils.js";
import { isExpectedResolvedSecretValue } from "./secret-value.js";
import { discoverConfigSecretTargetsByIds } from "./target-registry.js";

export type CommandSecretAssignment = {
  path: string;
  pathSegments: string[];
  value: unknown;
};

export type ResolveAssignmentsFromSnapshotResult = {
  assignments: CommandSecretAssignment[];
  diagnostics: string[];
};

export function collectCommandSecretAssignmentsFromSnapshot(params: {
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  commandName: string;
  targetIds: ReadonlySet<string>;
  inactiveRefPaths?: ReadonlySet<string>;
}): ResolveAssignmentsFromSnapshotResult {
  const defaults = params.sourceConfig.secrets?.defaults;
  const assignments: CommandSecretAssignment[] = [];
  const diagnostics: string[] = [];

  for (const target of discoverConfigSecretTargetsByIds(params.sourceConfig, params.targetIds)) {
    const { explicitRef, ref } = resolveSecretInputRef({
      value: target.value,
      refValue: target.refValue,
      defaults,
    });
    const inlineCandidateRef = explicitRef ? coerceSecretRef(target.value, defaults) : null;
    if (!ref) {
      continue;
    }

    const resolved = getPath(params.resolvedConfig, target.pathSegments);
    if (!isExpectedResolvedSecretValue(resolved, target.entry.expectedResolvedValue)) {
      if (params.inactiveRefPaths?.has(target.path)) {
        diagnostics.push(
          `${target.path}: secret ref is configured on an inactive surface; skipping command-time assignment.`,
        );
        continue;
      }
      throw new Error(
        `${params.commandName}: ${target.path} is unresolved in the active runtime snapshot.`,
      );
    }

    assignments.push({
      path: target.path,
      pathSegments: [...target.pathSegments],
      value: resolved,
    });

    if (target.entry.secretShape === "sibling_ref" && explicitRef && inlineCandidateRef) {
      diagnostics.push(
        `${target.path}: both inline and sibling ref were present; sibling ref took precedence.`,
      );
    }
  }

  return { assignments, diagnostics };
}
