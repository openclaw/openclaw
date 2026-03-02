import { normalizeOptionalSecretInput } from "../../utils/normalize-secret-input.js";

type EnvValue = {
  key: string;
  value: string;
};

export const AZURE_FOUNDRY_API_KEY_ENV_VARS = [
  "AZURE_FOUNDRY_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_INFERENCE_CREDENTIAL",
  "AZURE_AI_API_KEY",
] as const;

export const AZURE_FOUNDRY_ENDPOINT_ENV_VARS = [
  "AZURE_FOUNDRY_ENDPOINT",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_INFERENCE_ENDPOINT",
  "AZURE_AI_ENDPOINT",
] as const;

export const AZURE_FOUNDRY_API_VERSION_ENV_VARS = [
  "AZURE_FOUNDRY_API_VERSION",
  "AZURE_OPENAI_API_VERSION",
] as const;

function pickFirstSetEnvVar(
  env: NodeJS.ProcessEnv,
  vars: readonly string[],
  normalize: (value: string | undefined) => string | undefined,
): EnvValue | undefined {
  for (const key of vars) {
    const value = normalize(env[key]);
    if (value) {
      return { key, value };
    }
  }
  return undefined;
}

export function resolveAzureFoundryApiKeyEnv(
  env: NodeJS.ProcessEnv = process.env,
): EnvValue | undefined {
  return pickFirstSetEnvVar(env, AZURE_FOUNDRY_API_KEY_ENV_VARS, normalizeOptionalSecretInput);
}

export function resolveAzureFoundryEndpointEnv(
  env: NodeJS.ProcessEnv = process.env,
): EnvValue | undefined {
  return pickFirstSetEnvVar(env, AZURE_FOUNDRY_ENDPOINT_ENV_VARS, (value) => {
    const trimmed = value?.trim();
    return trimmed || undefined;
  });
}

export function resolveAzureFoundryApiVersionEnv(
  env: NodeJS.ProcessEnv = process.env,
): EnvValue | undefined {
  return pickFirstSetEnvVar(env, AZURE_FOUNDRY_API_VERSION_ENV_VARS, (value) => {
    const trimmed = value?.trim();
    return trimmed || undefined;
  });
}
