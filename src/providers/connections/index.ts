/**
 * Connection providers module.
 *
 * Provides OAuth2 connection infrastructure for external services
 * (GitHub, Slack, Google, Notion) with granular scope selection.
 */

// Types
export type {
  ConnectionProvider,
  ConnectionProviderOAuthConfig,
  ConnectionOAuthCredential,
  ConnectionState,
  ConnectionStatus,
  ConnectionUserInfo,
  ConnectionLoginOptions,
  ConnectionLogoutOptions,
  OAuthFlowState,
  OAuthFlowStartResult,
  OAuthFlowCompleteResult,
  ScopeDefinition,
  ScopeCategory,
  ScopePreset,
  ScopeRiskLevel,
} from "./types.js";

// Registry
export {
  registerConnectionProvider,
  getConnectionProvider,
  getAllConnectionProviders,
  getConnectionProviderIds,
  hasConnectionProvider,
  getDefaultScopes,
  getScopesForPreset,
  getPresetsForProvider,
  validateScopes,
  expandScopes,
  buildScopeString,
} from "./registry.js";

// Credentials
export {
  resolveConnectionCredential,
  hasConnectionCredential,
  getAllConnectionStatuses,
  getConnectionStatus,
  removeConnectionCredential,
  storeConnectionCredential,
  getConnectionProfileId,
  parseConnectionProfileId,
  isConnectionProfileId,
} from "./credentials.js";
export type {
  ResolveConnectionCredentialOptions,
  ResolvedConnectionCredential,
} from "./credentials.js";

// Provider implementations - importing these registers them
import "./github.js";
import "./slack.js";
import "./google.js";
import "./notion.js";

// Re-export provider-specific utilities if needed
export { fetchGitHubUserInfo, GITHUB_CLIENT_ID_ENV, GITHUB_CLIENT_SECRET_ENV } from "./github.js";
export { fetchSlackUserInfo, SLACK_CLIENT_ID_ENV, SLACK_CLIENT_SECRET_ENV } from "./slack.js";
export { fetchGoogleUserInfo, GOOGLE_CLIENT_ID_ENV, GOOGLE_CLIENT_SECRET_ENV } from "./google.js";
export { fetchNotionUserInfo, NOTION_CLIENT_ID_ENV, NOTION_CLIENT_SECRET_ENV } from "./notion.js";
