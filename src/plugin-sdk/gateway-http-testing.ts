// Repo-local Gateway HTTP fixtures for plugin tests. Extension suites use this
// instead of core src imports, and core type graphs do not import the plugin.
export { AUTH_NONE, sendRequest, withGatewayServer } from "../gateway/server-http.test-harness.js";
export {
  createGatewayPluginRequestHandler,
  shouldEnforceGatewayAuthForPluginPath,
} from "../gateway/server/plugins-http.js";
