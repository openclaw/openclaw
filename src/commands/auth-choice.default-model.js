import { ensureModelAllowlistEntry } from "./model-allowlist.js";
export async function applyDefaultModelChoice(params) {
    if (params.setDefaultModel) {
        const next = params.applyDefaultConfig(params.config);
        if (params.noteDefault) {
            await params.prompter.note(`Default model set to ${params.noteDefault}`, "Model configured");
        }
        return { config: next };
    }
    const next = params.applyProviderConfig(params.config);
    const nextWithModel = ensureModelAllowlistEntry({
        cfg: next,
        modelRef: params.defaultModel,
    });
    await params.noteAgentModel(params.defaultModel);
    return { config: nextWithModel, agentModelOverride: params.defaultModel };
}
