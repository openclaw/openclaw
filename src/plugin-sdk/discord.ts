// Narrow plugin-sdk surface for the external Discord channel plugin.
//
// @openclaw/discord@2026.3.13 imports `openclaw/plugin-sdk/discord` expecting
// generic plugin types and the empty config schema helper.  This barrel
// re-exports exactly those symbols so the external plugin resolves correctly
// when the package.json `exports` map includes `./plugin-sdk/discord`.
//
// See: https://github.com/openclaw/openclaw/issues/73685

export type { OpenClawPluginApi } from "../plugins/types.js";
export type { OpenClawConfig } from "../config/types.openclaw.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
