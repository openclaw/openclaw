// Narrow plugin-sdk surface for the bundled tinyfish plugin.
// Keep this list additive and scoped to symbols used under extensions/tinyfish.

export { jsonResult, readStringParam, ToolInputError } from "../agents/tools/common.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
