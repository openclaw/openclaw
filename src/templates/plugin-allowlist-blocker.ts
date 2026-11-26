import { validatePluginId } from "../plugins/install-paths.js";

// Plugin ids come from publisher artifacts. Only plain ids are echoed back to the operator.
const DISPLAYABLE_PLUGIN_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const MAX_DISPLAYABLE_PLUGIN_ID_LENGTH = 214;

/** Returns the runtime plugin id when it is safe to show and to copy into plugins.allow. */
export function displayableTemplatePluginId(pluginId: string | undefined): string | undefined {
  const trimmed = pluginId?.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_DISPLAYABLE_PLUGIN_ID_LENGTH ||
    !DISPLAYABLE_PLUGIN_ID.test(trimmed) ||
    validatePluginId(trimmed) !== null
  ) {
    return undefined;
  }
  return trimmed;
}

/** Local preview text for a Template plugin that is blocked only by plugins.allow. */
export function templatePluginAllowlistMessage(subject: string, pluginId: string): string {
  return `Plugin ${subject} has plugin id "${pluginId}", which is not in plugins.allow. Add "${pluginId}" to plugins.allow before adding this Template.`;
}

/** Gateway review text; it names only the validated runtime id, never package paths. */
export function templatePluginAllowlistReviewMessage(pluginId: string): string {
  return `Plugin "${pluginId}" is not in plugins.allow. Add "${pluginId}" to plugins.allow, then add this Template again.`;
}
