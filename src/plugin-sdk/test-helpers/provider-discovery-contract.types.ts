import type { registerProviderPlugins } from "../../test-utils/plugin-registration.js";

export type ProviderDiscoveryContractPluginLoader = () => Promise<{
  default: Parameters<typeof registerProviderPlugins>[0];
}>;
