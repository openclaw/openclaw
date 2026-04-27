import { type ModelAliasIndex } from "../../agents/model-selection-shared.js";
export type ModelDirectiveSelection = {
    provider: string;
    model: string;
    isDefault: boolean;
    alias?: string;
};
export declare function resolveModelDirectiveSelection(params: {
    raw: string;
    defaultProvider: string;
    defaultModel: string;
    aliasIndex: ModelAliasIndex;
    allowedModelKeys: Set<string>;
}): {
    selection?: ModelDirectiveSelection;
    error?: string;
};
