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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSecretRef(value: unknown): value is SecretRef {
  if (!isRecord(value)) {
    return false;
  }
  if (Object.keys(value).length !== 2) {
    return false;
  }
  return (
    (value.source === "env" || value.source === "file") &&
    typeof value.id === "string" &&
    value.id.trim().length > 0
  );
}

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
