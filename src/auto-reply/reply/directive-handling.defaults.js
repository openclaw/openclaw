import { buildModelAliasIndex, resolveDefaultModelForAgent, } from "../../agents/model-selection.js";
export function resolveDefaultModel(params) {
    const mainModel = resolveDefaultModelForAgent({
        cfg: params.cfg,
        agentId: params.agentId,
    });
    const defaultProvider = mainModel.provider;
    const defaultModel = mainModel.model;
    const aliasIndex = buildModelAliasIndex({
        cfg: params.cfg,
        defaultProvider,
    });
    return { defaultProvider, defaultModel, aliasIndex };
}
