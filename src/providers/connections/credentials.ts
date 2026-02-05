/**
 * Connection credential resolution helper.
 *
 * Provides a unified way for skills to resolve connection credentials
 * from the auth profile store.
 */

import type { OAuthCredential } from "../../agents/auth-profiles/types.js";
import type { ConnectionOAuthCredential, ConnectionStatus, ConnectionUserInfo } from "./types.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "../../agents/auth-profiles/store.js";
import { getConnectionProvider, getAllConnectionProviders } from "./registry.js";

/** Profile ID format for connection credentials */
export function getConnectionProfileId(providerId: string, email?: string): string {
  return `connection:${providerId}:${email ?? "default"}`;
}

/** Parse a connection profile ID to extract provider and email */
export function parseConnectionProfileId(
  profileId: string,
): { providerId: string; email: string } | null {
  const match = profileId.match(/^connection:([^:]+):(.+)$/);
  if (!match) {
    return null;
  }
  return { providerId: match[1], email: match[2] };
}

/** Check if a profile ID is a connection profile */
export function isConnectionProfileId(profileId: string): boolean {
  return profileId.startsWith("connection:");
}

/** Options for resolving connection credentials */
export interface ResolveConnectionCredentialOptions {
  /** Provider ID (e.g., "github", "slack") */
  provider: string;
  /** Agent directory for credential lookup */
  agentDir?: string;
  /** Whether to attempt token refresh if expired */
  autoRefresh?: boolean;
}

/** Result of credential resolution */
export interface ResolvedConnectionCredential {
  /** OAuth access token */
  access: string;
  /** Refresh token (if available) */
  refresh?: string;
  /** Token expiry timestamp */
  expires?: number;
  /** Whether the token is expired */
  isExpired: boolean;
  /** Provider ID */
  provider: string;
  /** Profile ID in store */
  profileId: string;
  /** User info from provider */
  userInfo?: ConnectionUserInfo;
  /** Granted scopes */
  grantedScopes?: string[];
}

/**
 * Resolve connection credentials for a provider.
 *
 * @example
 * ```typescript
 * const cred = await resolveConnectionCredential({ provider: 'github', agentDir });
 * if (cred) {
 *   const octokit = new Octokit({ auth: cred.access });
 * }
 * ```
 */
export async function resolveConnectionCredential(
  options: ResolveConnectionCredentialOptions,
): Promise<ResolvedConnectionCredential | null> {
  const { provider, agentDir, autoRefresh = true } = options;

  const connectionProvider = getConnectionProvider(provider);
  if (!connectionProvider) {
    return null;
  }

  const store = ensureAuthProfileStore(agentDir);

  // Find the connection profile for this provider
  const profilePrefix = `connection:${provider}:`;
  const profileId = Object.keys(store.profiles).find((id) => id.startsWith(profilePrefix));

  if (!profileId) {
    return null;
  }

  const cred = store.profiles[profileId];
  if (!cred || cred.type !== "oauth") {
    return null;
  }

  const oauthCred = cred as OAuthCredential & {
    grantedScopes?: string[];
    userInfo?: ConnectionUserInfo;
  };

  const isExpired =
    typeof oauthCred.expires === "number" &&
    Number.isFinite(oauthCred.expires) &&
    Date.now() >= oauthCred.expires;

  // Attempt auto-refresh if token is expired
  if (isExpired && autoRefresh && connectionProvider.refreshToken && oauthCred.refresh) {
    try {
      const connectionCred: ConnectionOAuthCredential = {
        ...oauthCred,
        connectionProvider: provider,
      };

      const refreshed = await connectionProvider.refreshToken(connectionCred);

      // Update the store with refreshed credentials
      store.profiles[profileId] = {
        ...cred,
        access: refreshed.access,
        refresh: refreshed.refresh ?? oauthCred.refresh,
        expires: refreshed.expires ?? oauthCred.expires,
      };
      saveAuthProfileStore(store, agentDir);

      return {
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
        isExpired: false,
        provider,
        profileId,
        userInfo: oauthCred.userInfo,
        grantedScopes: oauthCred.grantedScopes,
      };
    } catch {
      // Refresh failed, return expired credential
    }
  }

  return {
    access: oauthCred.access,
    refresh: oauthCred.refresh,
    expires: oauthCred.expires,
    isExpired,
    provider,
    profileId,
    userInfo: oauthCred.userInfo,
    grantedScopes: oauthCred.grantedScopes,
  };
}

/**
 * Check if a connection is established for a provider.
 */
export function hasConnectionCredential(provider: string, agentDir?: string): boolean {
  const store = ensureAuthProfileStore(agentDir);
  const profilePrefix = `connection:${provider}:`;
  return Object.keys(store.profiles).some((id) => id.startsWith(profilePrefix));
}

/**
 * Get connection status for all registered providers.
 */
export function getAllConnectionStatuses(agentDir?: string): ConnectionStatus[] {
  const store = ensureAuthProfileStore(agentDir);
  const providers = getAllConnectionProviders();

  return providers.map((provider) => {
    const profilePrefix = `connection:${provider.id}:`;
    const profileId = Object.keys(store.profiles).find((id) => id.startsWith(profilePrefix));

    if (!profileId) {
      return {
        providerId: provider.id,
        label: provider.label,
        connected: false,
      };
    }

    const cred = store.profiles[profileId];
    if (!cred || cred.type !== "oauth") {
      return {
        providerId: provider.id,
        label: provider.label,
        connected: false,
      };
    }

    const oauthCred = cred as OAuthCredential & {
      grantedScopes?: string[];
      userInfo?: ConnectionUserInfo;
    };

    const isExpired =
      typeof oauthCred.expires === "number" &&
      Number.isFinite(oauthCred.expires) &&
      Date.now() >= oauthCred.expires;

    return {
      providerId: provider.id,
      label: provider.label,
      connected: true,
      profileId,
      userInfo: oauthCred.userInfo,
      grantedScopes: oauthCred.grantedScopes,
      expiresAt: oauthCred.expires,
      isExpired,
    };
  });
}

/**
 * Get connection status for a specific provider.
 */
export function getConnectionStatus(
  providerId: string,
  agentDir?: string,
): ConnectionStatus | null {
  const provider = getConnectionProvider(providerId);
  if (!provider) {
    return null;
  }

  const store = ensureAuthProfileStore(agentDir);
  const profilePrefix = `connection:${providerId}:`;
  const profileId = Object.keys(store.profiles).find((id) => id.startsWith(profilePrefix));

  if (!profileId) {
    return {
      providerId: provider.id,
      label: provider.label,
      connected: false,
    };
  }

  const cred = store.profiles[profileId];
  if (!cred || cred.type !== "oauth") {
    return {
      providerId: provider.id,
      label: provider.label,
      connected: false,
    };
  }

  const oauthCred = cred as OAuthCredential & {
    grantedScopes?: string[];
    userInfo?: ConnectionUserInfo;
  };

  const isExpired =
    typeof oauthCred.expires === "number" &&
    Number.isFinite(oauthCred.expires) &&
    Date.now() >= oauthCred.expires;

  return {
    providerId: provider.id,
    label: provider.label,
    connected: true,
    profileId,
    userInfo: oauthCred.userInfo,
    grantedScopes: oauthCred.grantedScopes,
    expiresAt: oauthCred.expires,
    isExpired,
  };
}

/**
 * Remove connection credentials for a provider.
 */
export function removeConnectionCredential(providerId: string, agentDir?: string): boolean {
  const store = ensureAuthProfileStore(agentDir);
  const profilePrefix = `connection:${providerId}:`;
  const profileId = Object.keys(store.profiles).find((id) => id.startsWith(profilePrefix));

  if (!profileId) {
    return false;
  }

  delete store.profiles[profileId];
  saveAuthProfileStore(store, agentDir);
  return true;
}

/**
 * Store connection credentials after OAuth flow completion.
 */
export function storeConnectionCredential(params: {
  providerId: string;
  access: string;
  refresh?: string;
  expires?: number;
  email?: string;
  grantedScopes?: string[];
  userInfo?: ConnectionUserInfo;
  agentDir?: string;
}): string {
  const { providerId, access, refresh, expires, email, grantedScopes, userInfo, agentDir } = params;

  const store = ensureAuthProfileStore(agentDir);
  const profileId = getConnectionProfileId(providerId, email);

  store.profiles[profileId] = {
    type: "oauth",
    provider: `connection:${providerId}`,
    access,
    refresh: refresh ?? "",
    expires: expires ?? 0,
    grantedScopes,
    userInfo,
    email,
  } as OAuthCredential & {
    grantedScopes?: string[];
    userInfo?: ConnectionUserInfo;
  };

  saveAuthProfileStore(store, agentDir);
  return profileId;
}
