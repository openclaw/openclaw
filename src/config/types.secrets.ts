export type SecretRefSource = "env" | "file";

/**
 * Stable identifier for a secret in a configured source.
 * Examples:
 * - env source: "OPENAI_API_KEY"
 * - file source: "/providers/openai/api_key" (JSON pointer)
 */
export type SecretRef = {
  source: SecretRefSource;
  id: string;
};

export type SecretInput = string | SecretRef;

export type EnvSecretSourceConfig = {
  type?: "env";
};

export type SopsSecretSourceConfig = {
  type: "sops";
  path: string;
  timeoutMs?: number;
};

export type SecretsConfig = {
  sources?: {
    env?: EnvSecretSourceConfig;
    file?: SopsSecretSourceConfig;
  };
};
