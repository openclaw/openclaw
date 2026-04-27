export {
  /**
   * @deprecated Use getRuntimeConfig(), runtime.config.current(), or pass the
   * already loaded config through the call path. Runtime code must not reload
   * config on demand. Bundled plugins and repo code are blocked from using
   * this by the deprecated-internal-config-api architecture guard.
   */
  createConfigIO,
  getRuntimeConfig,
  getRuntimeConfigSnapshot,
  /**
   * @deprecated Use getRuntimeConfig(), runtime.config.current(), or pass the
   * already loaded config through the call path. Runtime code must not reload
   * config on demand. Bundled plugins and repo code are blocked from using
   * this by the deprecated-internal-config-api architecture guard.
   */
  loadConfig,
  /**
   * @deprecated Use mutateConfigFile() or replaceConfigFile() with an explicit
   * afterWrite intent so restart behavior stays under host control. Bundled
   * plugins and repo code are blocked from using this by the
   * deprecated-internal-config-api architecture guard.
   */
  writeConfigFile,
  type BrowserConfig,
  type BrowserProfileConfig,
  type OpenClawConfig,
} from "../config/config.js";
export { mutateConfigFile, replaceConfigFile } from "../config/mutate.js";
export { resolveConfigPath, resolveGatewayPort } from "../config/paths.js";
export {
  DEFAULT_BROWSER_CONTROL_PORT,
  deriveDefaultBrowserCdpPortRange,
  deriveDefaultBrowserControlPort,
} from "../config/port-defaults.js";
export { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
export { parseBooleanValue } from "../utils/boolean.js";
export { CONFIG_DIR, escapeRegExp, resolveUserPath, shortenHomePath } from "../utils.js";
