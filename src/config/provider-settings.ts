import { isPluginJsonValue } from "../plugins/host-hook-json.js";
import { isValidSecretRef } from "../secrets/ref-contract.js";
import { isSensitiveConfigPath } from "./sensitive-paths.js";
import { isSecretRef } from "./types.secrets.js";

export const WORKER_PROFILE_SETTINGS_JSON_LIMITS = { maxValueStringLength: 128 * 1024 } as const;

/** Provider settings stay bounded JSON and retain secrets as references until provider use. */
export function validateProviderSettings(
  value: unknown,
  label: string,
  options?: { maxValueStringLength: number },
): string | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !isPluginJsonValue(value, options)
  ) {
    return `${label} settings must be bounded finite JSON`;
  }
  const visit = (entry: unknown): string | undefined => {
    if (Array.isArray(entry)) {
      return entry.map(visit).find((error) => error !== undefined);
    }
    if (typeof entry !== "object" || entry === null) {
      return undefined;
    }
    for (const [key, child] of Object.entries(entry)) {
      const baseKey = key.replace(/ref$/i, "");
      const isSensitive =
        key.toLowerCase() === "keyref" ||
        /^(?:accesskeyid|passphrase)$/i.test(baseKey) ||
        isSensitiveConfigPath(key) ||
        (baseKey !== key && isSensitiveConfigPath(baseKey));
      if (isSensitive) {
        if (!isSecretRef(child) || !isValidSecretRef(child)) {
          return `${label} ${key} must use a SecretRef`;
        }
        continue;
      }
      const error = visit(child);
      if (error) {
        return error;
      }
    }
    return undefined;
  };
  return visit(value);
}
