import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export const PROVIDER_PLUGIN_CHOICE_PREFIX = "provider-plugin:";

export function buildProviderPluginMethodChoice(providerId: string, methodId: string): string {
  return `${PROVIDER_PLUGIN_CHOICE_PREFIX}${normalizeOptionalString(providerId) ?? ""}:${normalizeOptionalString(methodId) ?? ""}`;
}

/** Parse explicit dispatch identity before consulting user-facing manifest choice IDs. */
export function parseProviderPluginMethodChoice(
  choice: string,
): { providerId: string; methodId?: string } | undefined {
  const normalized = choice.trim();
  if (!normalized.startsWith(PROVIDER_PLUGIN_CHOICE_PREFIX)) {
    return undefined;
  }
  const payload = normalized.slice(PROVIDER_PLUGIN_CHOICE_PREFIX.length);
  const separator = payload.indexOf(":");
  return {
    providerId: (separator >= 0 ? payload.slice(0, separator) : payload).trim(),
    ...(separator >= 0 ? { methodId: payload.slice(separator + 1).trim() } : {}),
  };
}
