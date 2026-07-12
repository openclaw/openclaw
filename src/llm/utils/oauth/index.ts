/**
 * OAuth credential management for AI providers.
 *
 * This module handles login, token refresh, and credential storage
 * for OAuth-based providers:
 * - Anthropic (Claude Pro/Max)
 * - GitHub Copilot
 */

// Anthropic
// GitHub Copilot
// OpenAI Codex (ChatGPT OAuth)

export * from "./types.js";

// ============================================================================
// Provider Registry
// ============================================================================

import { anthropicOAuthProvider } from "./anthropic.js";
import { githubCopilotOAuthProvider } from "./github-copilot.js";
import { openaiCodexOAuthProvider } from "./openai-chatgpt.js";
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInterface } from "./types.js";

const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
  anthropicOAuthProvider,
  githubCopilotOAuthProvider,
  openaiCodexOAuthProvider,
];

const oauthProviderRegistry = new Map<string, OAuthProviderInterface>(
  BUILT_IN_OAUTH_PROVIDERS.map((provider) => [provider.id, provider]),
);

/**
 * Get an OAuth provider by ID
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
  return oauthProviderRegistry.get(id);
}

/**
 * Register a custom OAuth provider
 */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
  oauthProviderRegistry.set(provider.id, provider);
}

/**
 * Reset OAuth providers to built-ins.
 */
export function resetOAuthProviders(): void {
  oauthProviderRegistry.clear();
  for (const provider of BUILT_IN_OAUTH_PROVIDERS) {
    oauthProviderRegistry.set(provider.id, provider);
  }
}

/**
 * Get all registered OAuth providers
 */
export function getOAuthProviders(): OAuthProviderInterface[] {
  return Array.from(oauthProviderRegistry.values());
}

// ============================================================================
// High-level API (uses provider registry)
// ============================================================================

import { hasUsableOAuthCredential } from "../../plugin-sdk/provider-auth.js";

/**
 * Get API key for a provider from OAuth credentials.
 * Automatically refreshes expired tokens.
 *
 * @returns API key string and updated credentials, or null if no credentials
 * @throws Error if refresh fails
 */
export async function getOAuthApiKey(
  providerId: OAuthProviderId,
  credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: *** } | null> {
  const provider = getOAuthProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown OAuth provider: ${providerId}`);
  }

  let creds = credentials[providerId];
  if (!creds) {
    return null;
  }

  // Refresh when the credential is not usable within the standard refresh
  // margin, matching the manager gate (hasUsableOAuthCredential). The raw
  // expiry check here previously skipped refresh during the margin window,
  // so a caller that decided to refresh (under the margin) would silently
  // receive the unchanged credential. See issue #103846.
  if (!hasUsableOAuthCredential(creds)) {
    try {
      creds = await provider.refreshToken(creds);
    } catch (error) {
      throw new Error(`Failed to refresh OAuth token for ${providerId}`, { cause: error });
    }
  }

  const apiKey = provider.getApiKey(creds);
  return { newCredentials: creds, apiKey };
}
