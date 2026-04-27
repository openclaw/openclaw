import type { PluginDiagnostic } from "./manifest-types.js";
import type { ProviderPlugin } from "./types.js";
export declare function normalizeRegisteredProvider(params: {
    pluginId: string;
    source: string;
    provider: ProviderPlugin;
    pushDiagnostic: (diag: PluginDiagnostic) => void;
}): ProviderPlugin | null;
