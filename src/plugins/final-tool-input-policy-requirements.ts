// Resolves operator-owned final tool-input policy requirements without loading plugin runtime.
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "./config-state.js";

/** Plugin owners whose configured final-input policies are mandatory at runtime. */
export function resolveRequiredFinalToolInputPolicyOwnerIds(
  config: OpenClawConfig | undefined,
): string[] {
  const entries = normalizePluginsConfig(config?.plugins).entries;
  return normalizeSortedUniqueStringEntries(
    Object.entries(entries)
      .filter(([, entry]) => (entry.requiredFinalToolInputPolicies?.length ?? 0) > 0)
      .map(([pluginId]) => pluginId),
  );
}
