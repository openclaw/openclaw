/**
 * Constitutional Alignment Plugin
 *
 * Injects constitutional principles into the system prompt via the
 * before_prompt_build hook. Adds ~500 tokens to context.
 *
 * Always-on: immutable principles cannot be disabled.
 */

import type { SecurityAlignmentConfig } from "../config/types.openclaw.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import { loadConstitution, formatConstitutionForPrompt } from "./constitution.js";

const ALIGNMENT_HOOK_PRIORITY = 800;

/**
 * Register the alignment plugin hooks.
 * Called by the safety plugin during initialization.
 */
export function registerAlignmentHooks(
  api: OpenClawPluginApi,
  config?: SecurityAlignmentConfig,
): void {
  // Default enabled unless explicitly disabled
  const enabled = config?.enabled !== false;
  if (!enabled) {
    return;
  }

  const constitution = loadConstitution(config);
  const constitutionPrompt = formatConstitutionForPrompt(constitution);

  api.on(
    "before_prompt_build",
    (_event, _ctx) => {
      return {
        prependContext: constitutionPrompt,
      };
    },
    { priority: ALIGNMENT_HOOK_PRIORITY },
  );
}
