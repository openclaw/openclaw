export { collectProviderDangerousNameMatchingScopes } from "../config/dangerous-name-matching.js";
export {
  hasLegacyAccountStreamingAliases,
  hasLegacyStreamingAliases,
  normalizeLegacyDmAliases,
  normalizeLegacyStreamingAliases,
} from "../config/channel-compat-normalization.js";
export {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
} from "../infra/plugin-install-path-warnings.js";
export { removePluginFromConfig } from "../plugins/uninstall.js";
