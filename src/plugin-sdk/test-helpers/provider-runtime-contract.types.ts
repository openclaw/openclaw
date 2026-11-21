// Shared leaf type: registration input ownership without a helper implementation edge.
import type { registerProviderPlugin } from "../../test-utils/plugin-registration.js";

export type ProviderRuntimeContractPluginLoader = () => Promise<{
  default: Parameters<typeof registerProviderPlugin>[0]["plugin"];
}>;
