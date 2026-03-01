import type { OpenClawConfig } from "../config/config.js";
import { normalizeSecretInputString, resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveSecretRefString } from "../secrets/resolve.js";

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

function formatSecretResolutionError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export async function resolveOnboardingSecretInputString(params: {
  config: OpenClawConfig;
  value: unknown;
  path: string;
  defaults?: SecretDefaults;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const inline = normalizeSecretInputString(params.value);
  if (inline) {
    return inline;
  }

  const defaults = params.defaults ?? params.config.secrets?.defaults;
  const { ref } = resolveSecretInputRef({
    value: params.value,
    defaults,
  });
  if (!ref) {
    return undefined;
  }

  try {
    return await resolveSecretRefString(ref, {
      config: params.config,
      env: params.env ?? process.env,
    });
  } catch (error) {
    throw new Error(
      `${params.path}: failed to resolve SecretRef "${ref.source}:${ref.provider}:${ref.id}": ${formatSecretResolutionError(error)}`,
      { cause: error },
    );
  }
}
