import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConfigValidationIssue } from "../config/types.openclaw.js";

const PLUGIN_POLICY_QUARANTINED = "PLUGIN_POLICY_QUARANTINED";

/** Neither spelling wins an ambiguous permission; the optional owner stays inactive. */
export function hasConflictingPluginPromptPolicy(hooks: unknown): boolean {
  return (
    isRecord(hooks) &&
    typeof hooks.allowPromptInjection === "boolean" &&
    typeof hooks.allowPromptModification === "boolean" &&
    hooks.allowPromptInjection !== hooks.allowPromptModification
  );
}

/** Runtime-only projection. Doctor and writers still validate the untouched authored policy. */
export function projectPluginPolicyQuarantine(raw: unknown): {
  config: unknown;
  warnings: ConfigValidationIssue[];
} {
  if (!isRecord(raw) || !isRecord(raw.plugins) || !isRecord(raw.plugins.entries)) {
    return { config: raw, warnings: [] };
  }
  let entries: Record<string, unknown> | undefined;
  const warnings: ConfigValidationIssue[] = [];
  for (const [id, entry] of Object.entries(raw.plugins.entries)) {
    if (
      !isRecord(entry) ||
      !isRecord(entry.hooks) ||
      !hasConflictingPluginPromptPolicy(entry.hooks)
    ) {
      continue;
    }
    entries ??= { ...raw.plugins.entries };
    const hooks = { ...entry.hooks };
    delete hooks.allowPromptInjection;
    entries[id] = { ...entry, enabled: false, hooks };
    warnings.push({
      path: `plugins.entries.${id}.hooks`,
      errorCode: PLUGIN_POLICY_QUARANTINED,
      message: `Plugin "${id}" is quarantined for this runtime because allowPromptInjection and allowPromptModification conflict. Its hooks and capabilities are unavailable. Source config and includes are unchanged. Resolve the conflicting permission values explicitly, then run openclaw doctor --fix or save the corrected config to reload.`,
    });
  }
  return {
    config: entries ? { ...raw, plugins: { ...raw.plugins, entries } } : raw,
    warnings,
  };
}

/** A usable degraded runtime must never certify its invalid source as a recovery baseline. */
export function hasPluginPolicyQuarantine(snapshot: {
  warnings: readonly ConfigValidationIssue[];
}): boolean {
  return snapshot.warnings.some((issue) => issue.errorCode === PLUGIN_POLICY_QUARANTINED);
}
