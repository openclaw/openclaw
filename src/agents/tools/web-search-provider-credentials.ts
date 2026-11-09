import { normalizeSecretInputString, resolveSecretInputRef } from "../../config/types.secrets.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { readWebProviderEnvValue } from "../../web/provider-runtime-shared.js";

export function resolveWebSearchProviderCredential(params: {
  credentialValue: unknown;
  path: string;
  envVars: string[];
}): string | undefined {
  const credentialRef = resolveSecretInputRef({ value: params.credentialValue }).ref;
  if (credentialRef) {
    if (credentialRef.source !== "env") {
      // Web-search providers only accept concrete env-backed values at runtime.
      return undefined;
    }
    return normalizeSecretInput(process.env[credentialRef.id]) || undefined;
  }

  return (
    normalizeSecretInput(normalizeSecretInputString(params.credentialValue)) ||
    readWebProviderEnvValue(params.envVars)
  );
}
