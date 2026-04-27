import type { ProviderPlugin } from "./types.js";
type ProviderContractEntry = {
    pluginId: string;
    provider: ProviderPlugin;
};
export declare function resolveBundledExplicitProviderContractsFromPublicArtifacts(params: {
    onlyPluginIds: readonly string[];
}): ProviderContractEntry[] | null;
export {};
