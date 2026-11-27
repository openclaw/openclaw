// Private Gateway config helpers keep bundled cold-start paths out of broad SDK barrels.
export {
  type GmailHookOverrides,
  type GmailHookRuntimeConfig,
  DEFAULT_GMAIL_LABEL,
  DEFAULT_GMAIL_TOPIC,
  DEFAULT_GMAIL_SUBSCRIPTION,
  DEFAULT_GMAIL_SERVE_BIND,
  DEFAULT_GMAIL_SERVE_PORT,
  DEFAULT_GMAIL_SERVE_PATH,
  DEFAULT_GMAIL_MAX_BYTES,
  DEFAULT_GMAIL_RENEW_MINUTES,
  resolveGmailHookMaxBytes,
} from "../config/gmail-hook.js";
export { DEFAULT_GATEWAY_PORT, resolveGatewayPort } from "../config/paths.js";
export { classifyGatewayProbePath } from "../gateway/gateway-http-route-contracts.js";
export {
  isProtectedPluginRoutePathFromContext,
  resolvePluginRoutePathContext,
} from "../gateway/server/plugins-http/path-context.js";
export { hasUnresolvedConfigValue } from "../config/unresolved-config-value.js";
export { isNamedOperatorRoleEnforcementEnabled } from "../gateway/operator-role-enforcement.js";
