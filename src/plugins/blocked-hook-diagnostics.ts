import type { PluginDiagnosticCode } from "./manifest-types.js";

/** Diagnostic fields the match needs; both status records and raw diagnostics satisfy it. */
type BlockedHookDiagnosticLike = {
  message: string;
  pluginId?: string;
  code?: PluginDiagnosticCode;
};

/** Refusal fields the match needs, shared by the registry record and the status record. */
type BlockedHookRefusalLike = {
  pluginId: string;
  message: string;
};

/**
 * A refused hook registration reaches an operator twice: once as a
 * `hook-registration-blocked` diagnostic and once in the dedicated blocked-hook
 * section, which also names the hook and the config key that unblocks it. Views
 * that render both must drop the diagnostic copy, but only when the section
 * really reports that refusal — an unmatched diagnostic is the operator's only
 * record of it and must still count as a problem.
 */
export function isBlockedHookDiagnosticReported(
  diagnostic: BlockedHookDiagnosticLike,
  blockedHooks: readonly BlockedHookRefusalLike[],
): boolean {
  if (diagnostic.code !== "hook-registration-blocked") {
    return false;
  }
  return blockedHooks.some(
    (blocked) =>
      blocked.message === diagnostic.message &&
      (diagnostic.pluginId == null || blocked.pluginId === diagnostic.pluginId),
  );
}
