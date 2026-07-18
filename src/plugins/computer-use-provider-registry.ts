/** Validation for plugin-owned Computer Use provider descriptors. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeCapabilityProviderId } from "./provider-registry-shared.js";
import type { ComputerUseProviderDescriptor } from "./types.js";

type ComputerUseProviderValidation =
  | { ok: true; provider: ComputerUseProviderDescriptor }
  | { ok: false; message: string };

/** Validates descriptor identity and manifest ownership without defining launch behavior. */
export function validateComputerUseProviderDescriptor(
  provider: ComputerUseProviderDescriptor,
  declaredIds: readonly string[],
): ComputerUseProviderValidation {
  const id = normalizeCapabilityProviderId(provider?.id);
  if (!id) {
    return { ok: false, message: "Computer Use provider registration missing valid id" };
  }
  const label = normalizeOptionalString(provider.label);
  if (!label) {
    return { ok: false, message: `Computer Use provider "${id}" registration missing label` };
  }
  const declared = declaredIds.some((candidate) => normalizeCapabilityProviderId(candidate) === id);
  return declared
    ? { ok: true, provider: { id, label } }
    : {
        ok: false,
        message: `plugin must declare contracts.computerUseProviders for provider: ${id}`,
      };
}
