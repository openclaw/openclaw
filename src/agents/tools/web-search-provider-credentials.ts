import { normalizeResolvedSecretInputString } from "../../config/types.secrets.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";

export function resolveWebSearchProviderCredential(params: {
  credentialValue: unknown;
  path: string;
  envVars: string[];
}): string | undefined {
  const fromConfigRaw = normalizeResolvedSecretInputString({
    value: params.credentialValue,
    path: params.path,
  });
  const fromConfig = normalizeSecretInput(fromConfigRaw);
  if (fromConfig) {
    return fromConfig;
  }

  for (const envVar of params.envVars) {
    const fromEnv = normalizeSecretInput(process.env[envVar]);
    if (fromEnv) {
      return fromEnv;
    }
  }

  return undefined;
}
