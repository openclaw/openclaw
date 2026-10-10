/** Resolves inline string or SecretRef inputs into normalized secret strings. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeSecretInputString,
  parseSecretRef,
  type SecretRef,
} from "../config/types.secrets.js";

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

/**
 * Resolves a config value that may be either an inline string or a SecretRef object.
 *
 * Gateway and storage callers can override normalization and convert SecretRef resolution errors
 * into surface-specific failures without duplicating provider lookup behavior.
 */
export async function materializeSecretInput(params: {
  config: OpenClawConfig;
  /** Inline string, SecretInput object, or SecretRef object from config/plugin settings. */
  value: unknown;
  env: NodeJS.ProcessEnv;
  /** Provider default for supported environment shorthand. */
  defaults?: SecretDefaults;
  /** Surface-specific normalization for resolved or inline values. */
  normalize?: (value: unknown) => string | undefined;
  /** Converts provider resolution failures into caller-specific errors. */
  onResolveRefError?: (error: unknown, ref: SecretRef) => never;
}): Promise<string | undefined> {
  const normalize = params.normalize ?? normalizeSecretInputString;
  const ref = parseSecretRef(params.value, params.defaults ?? params.config.secrets?.defaults);
  if (!ref) {
    return normalize(params.value);
  }

  let resolved: string;
  try {
    const { resolveSecretRefString } = await import("./resolve.js");
    resolved = await resolveSecretRefString(ref, {
      config: params.config,
      env: params.env,
    });
  } catch (error) {
    if (params.onResolveRefError) {
      return params.onResolveRefError(error, ref);
    }
    throw error;
  }
  return normalize(resolved);
}
