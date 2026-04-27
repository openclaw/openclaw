import type { SecretRef } from "../config/types.secrets.js";

export type SecretProviderResolveContext = {
  refs: SecretRef[];
  /** User-chosen alias from secrets.providers.<name>. */
  providerName: string;
  /** Already validated by SecretProviderPlugin.validateConfig (if defined). */
  providerConfig: unknown;
  env: NodeJS.ProcessEnv;
};

export type SecretProviderPlugin = {
  /** Matches the SecretRefSource string this plugin owns (e.g. "gcp", "keyring"). */
  id: string;
  label: string;
  /**
   * Resolve a batch of refs. Returns a Map keyed by SecretRef.id; missing keys
   * are treated as unresolved by the caller. Throw on hard failures.
   */
  resolve: (ctx: SecretProviderResolveContext) => Promise<Map<string, unknown>>;
  /** Optional richer validation; throw on invalid config. */
  validateConfig?: (cfg: unknown) => void;
};

export type PluginSecretProviderEntry = SecretProviderPlugin & {
  pluginId: string;
};
