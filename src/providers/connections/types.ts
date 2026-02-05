/**
 * Connection provider types for OAuth2 integrations.
 *
 * Connection providers represent external services (GitHub, Slack, Google, Notion)
 * that can be connected via OAuth2 for agent tool access.
 */

import type { OAuthCredential } from "../../agents/auth-profiles/types.js";

/** Risk level for a scope - affects UI display and grouping */
export type ScopeRiskLevel = "low" | "medium" | "high";

/** Individual OAuth scope definition with metadata for UI display */
export interface ScopeDefinition {
  /** Scope identifier (e.g., "repo", "chat:write") */
  id: string;
  /** Human-readable label */
  label: string;
  /** Description of what this scope grants */
  description: string;
  /** Risk level affects UI styling and warnings */
  risk: ScopeRiskLevel;
  /** If true, scope cannot be deselected */
  required?: boolean;
  /** If true, scope is pre-selected by default */
  recommended?: boolean;
  /** Example actions enabled by this scope */
  examples?: string[];
  /** Other scopes auto-granted when this is selected */
  implies?: string[];
}

/** Category grouping for scopes (e.g., "Repository", "Organization") */
export interface ScopeCategory {
  id: string;
  label: string;
  description?: string;
  /** Scope IDs in this category */
  scopes: string[];
  /** If true, category is collapsed by default */
  collapsed?: boolean;
}

/** Pre-configured scope presets for common use cases */
export interface ScopePreset {
  id: string;
  label: string;
  description?: string;
  /** Scope IDs included in this preset */
  scopes: string[];
}

/** OAuth configuration for a connection provider */
export interface ConnectionProviderOAuthConfig {
  /** Authorization endpoint URL */
  authorizeUrl: string;
  /** Token exchange endpoint URL */
  tokenUrl: string;
  /** User info endpoint URL (optional) */
  userInfoUrl?: string;
  /** Available scopes with metadata */
  scopes: ScopeDefinition[];
  /** Optional scope categories for grouped display */
  scopeCategories?: ScopeCategory[];
  /** Optional presets for common configurations */
  presets?: ScopePreset[];
  /** If true, PKCE is required (recommended for all public clients) */
  pkceRequired?: boolean;
  /** Environment variable name for user-provided client ID */
  clientIdEnvVar?: string;
  /** Environment variable name for user-provided client secret */
  clientSecretEnvVar?: string;
  /** Default redirect URI path (appended to base URL) */
  defaultRedirectPath?: string;
  /** Additional parameters to include in authorize request */
  authorizeParams?: Record<string, string>;
  /** Scope separator (default: space) */
  scopeSeparator?: string;
}

/** Connection provider definition */
export interface ConnectionProvider {
  /** Unique provider identifier (e.g., "github", "slack") */
  id: string;
  /** Display name */
  label: string;
  /** Provider icon identifier */
  icon?: string;
  /** Path to documentation */
  docsPath?: string;
  /** OAuth configuration */
  oauth: ConnectionProviderOAuthConfig;
  /** Custom token refresh handler (optional) */
  refreshToken?: (cred: ConnectionOAuthCredential) => Promise<ConnectionOAuthCredential>;
  /** Custom user info fetcher (optional) */
  fetchUserInfo?: (accessToken: string) => Promise<ConnectionUserInfo | null>;
}

/** User info returned from provider's userinfo endpoint */
export interface ConnectionUserInfo {
  /** Provider-specific user ID */
  id?: string;
  /** Username or handle */
  username?: string;
  /** Display name */
  name?: string;
  /** Email address */
  email?: string;
  /** Avatar URL */
  avatarUrl?: string;
}

/** OAuth credential with connection-specific metadata */
export interface ConnectionOAuthCredential extends OAuthCredential {
  /** Provider ID this credential belongs to */
  connectionProvider: string;
  /** Granted scope IDs */
  grantedScopes?: string[];
  /** User info from the provider */
  userInfo?: ConnectionUserInfo;
  /** When the credential was created */
  createdAt?: number;
  /** When the credential was last used */
  lastUsedAt?: number;
}

/** Stored connection state */
export interface ConnectionState {
  /** Provider ID */
  providerId: string;
  /** Whether connection is active */
  connected: boolean;
  /** Profile ID in auth store */
  profileId?: string;
  /** Granted scopes */
  grantedScopes?: string[];
  /** User info */
  userInfo?: ConnectionUserInfo;
  /** Last successful sync timestamp */
  lastSync?: number;
  /** Sync options enabled for this connection */
  syncOptions?: Record<string, boolean>;
  /** Error message if connection failed */
  error?: string;
}

/** OAuth flow state for CSRF protection */
export interface OAuthFlowState {
  /** Random state parameter */
  state: string;
  /** PKCE code verifier */
  codeVerifier?: string;
  /** Provider ID */
  providerId: string;
  /** Requested scopes */
  requestedScopes: string[];
  /** Redirect URI used */
  redirectUri: string;
  /** When this state was created */
  createdAt: number;
  /** Agent directory for credential storage */
  agentDir?: string;
}

/** Result of starting an OAuth flow */
export interface OAuthFlowStartResult {
  /** Authorization URL to redirect user to */
  authorizeUrl: string;
  /** Flow state for verification on callback */
  flowState: OAuthFlowState;
}

/** Result of completing an OAuth flow */
export interface OAuthFlowCompleteResult {
  /** Whether the flow succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Stored credential profile ID */
  profileId?: string;
  /** User info from provider */
  userInfo?: ConnectionUserInfo;
  /** Granted scopes */
  grantedScopes?: string[];
}

/** Options for the OAuth login flow */
export interface ConnectionLoginOptions {
  /** Provider ID to connect */
  providerId: string;
  /** Specific scopes to request (uses defaults if not specified) */
  scopes?: string[];
  /** Use a preset instead of individual scopes */
  preset?: string;
  /** Agent directory for credential storage */
  agentDir?: string;
  /** Custom redirect URI (for CLI vs web) */
  redirectUri?: string;
  /** Whether running in remote/VPS environment */
  isRemote?: boolean;
}

/** Options for disconnecting a provider */
export interface ConnectionLogoutOptions {
  /** Provider ID to disconnect */
  providerId: string;
  /** Agent directory */
  agentDir?: string;
  /** Whether to revoke tokens at provider (if supported) */
  revokeTokens?: boolean;
}

/** Connection status information */
export interface ConnectionStatus {
  /** Provider ID */
  providerId: string;
  /** Provider display name */
  label: string;
  /** Whether connected */
  connected: boolean;
  /** Profile ID in auth store */
  profileId?: string;
  /** User info if connected */
  userInfo?: ConnectionUserInfo;
  /** Granted scopes if connected */
  grantedScopes?: string[];
  /** Token expiry timestamp */
  expiresAt?: number;
  /** Whether token is expired */
  isExpired?: boolean;
  /** Last sync timestamp */
  lastSync?: number;
  /** Error message if any */
  error?: string;
}
