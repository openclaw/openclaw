import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type { ProviderResolveDynamicModelContext } from "./types.js";
export declare function matchesExactOrPrefix(id: string, values: readonly string[]): boolean;
export declare function cloneFirstTemplateModel(params: {
    providerId: string;
    modelId: string;
    templateIds: readonly string[];
    ctx: ProviderResolveDynamicModelContext;
    patch?: Partial<ProviderRuntimeModel>;
}): ProviderRuntimeModel | undefined;
