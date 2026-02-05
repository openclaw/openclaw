/**
 * Connection provider registry.
 *
 * Central registry for all connection providers. Providers register themselves
 * here and can be looked up by ID.
 */

import type { ConnectionProvider, ScopePreset } from "./types.js";

const providers = new Map<string, ConnectionProvider>();

/**
 * Register a connection provider.
 * Should be called during module initialization.
 */
export function registerConnectionProvider(provider: ConnectionProvider): void {
  if (providers.has(provider.id)) {
    throw new Error(`Connection provider "${provider.id}" is already registered`);
  }
  providers.set(provider.id, provider);
}

/**
 * Get a connection provider by ID.
 * Returns undefined if not found.
 */
export function getConnectionProvider(id: string): ConnectionProvider | undefined {
  return providers.get(id);
}

/**
 * Get all registered connection providers.
 */
export function getAllConnectionProviders(): ConnectionProvider[] {
  return Array.from(providers.values());
}

/**
 * Get provider IDs that are available for connection.
 */
export function getConnectionProviderIds(): string[] {
  return Array.from(providers.keys());
}

/**
 * Check if a provider is registered.
 */
export function hasConnectionProvider(id: string): boolean {
  return providers.has(id);
}

/**
 * Get the default scopes for a provider.
 * Returns required + recommended scopes.
 */
export function getDefaultScopes(providerId: string): string[] {
  const provider = providers.get(providerId);
  if (!provider) {
    return [];
  }
  return provider.oauth.scopes
    .filter((scope) => scope.required || scope.recommended)
    .map((scope) => scope.id);
}

/**
 * Get scopes for a preset.
 */
export function getScopesForPreset(providerId: string, presetId: string): string[] | undefined {
  const provider = providers.get(providerId);
  if (!provider) {
    return undefined;
  }
  const preset = provider.oauth.presets?.find((p) => p.id === presetId);
  return preset?.scopes;
}

/**
 * Get all presets for a provider.
 */
export function getPresetsForProvider(providerId: string): ScopePreset[] {
  const provider = providers.get(providerId);
  return provider?.oauth.presets ?? [];
}

/**
 * Validate that requested scopes are valid for a provider.
 * Returns invalid scope IDs if any are found.
 */
export function validateScopes(providerId: string, scopeIds: string[]): string[] {
  const provider = providers.get(providerId);
  if (!provider) {
    return scopeIds;
  }
  const validScopeIds = new Set(provider.oauth.scopes.map((s) => s.id));
  return scopeIds.filter((id) => !validScopeIds.has(id));
}

/**
 * Expand scopes to include implied scopes.
 */
export function expandScopes(providerId: string, scopeIds: string[]): string[] {
  const provider = providers.get(providerId);
  if (!provider) {
    return scopeIds;
  }

  const scopeMap = new Map(provider.oauth.scopes.map((s) => [s.id, s]));
  const result = new Set(scopeIds);

  // Add implied scopes recursively
  const addImplied = (id: string) => {
    const scope = scopeMap.get(id);
    if (scope?.implies) {
      for (const implied of scope.implies) {
        if (!result.has(implied)) {
          result.add(implied);
          addImplied(implied);
        }
      }
    }
  };

  for (const id of scopeIds) {
    addImplied(id);
  }

  // Always include required scopes
  for (const scope of provider.oauth.scopes) {
    if (scope.required) {
      result.add(scope.id);
    }
  }

  return Array.from(result);
}

/**
 * Build the scope string for the OAuth authorize URL.
 */
export function buildScopeString(providerId: string, scopeIds: string[]): string {
  const provider = providers.get(providerId);
  const separator = provider?.oauth.scopeSeparator ?? " ";
  const expanded = expandScopes(providerId, scopeIds);
  return expanded.join(separator);
}

// Re-export types
export type { ConnectionProvider, ScopeDefinition, ScopeCategory, ScopePreset } from "./types.js";
