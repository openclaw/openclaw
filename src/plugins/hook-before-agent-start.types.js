export const PLUGIN_PROMPT_MUTATION_RESULT_FIELDS = [
    "systemPrompt",
    "prependContext",
    "prependSystemContext",
    "appendSystemContext",
];
const assertAllPluginPromptMutationResultFieldsListed = true;
void assertAllPluginPromptMutationResultFieldsListed;
export const stripPromptMutationFieldsFromLegacyHookResult = (result) => {
    if (!result || typeof result !== "object") {
        return result;
    }
    const remaining = { ...result };
    for (const field of PLUGIN_PROMPT_MUTATION_RESULT_FIELDS) {
        delete remaining[field];
    }
    return Object.keys(remaining).length > 0
        ? remaining
        : undefined;
};
