import { resolveLegacyAuthChoiceAliasesForCli } from "./auth-choice-legacy.js";
export const CORE_AUTH_CHOICE_OPTIONS = [
    {
        value: "custom-api-key",
        label: "Custom Provider",
        hint: "Any OpenAI or Anthropic compatible endpoint",
        groupId: "custom",
        groupLabel: "Custom Provider",
        groupHint: "Any OpenAI or Anthropic compatible endpoint",
    },
];
export function formatStaticAuthChoiceChoicesForCli(params) {
    const includeSkip = params?.includeSkip ?? true;
    const includeLegacyAliases = params?.includeLegacyAliases ?? false;
    const values = CORE_AUTH_CHOICE_OPTIONS.map((opt) => opt.value);
    if (includeSkip) {
        values.push("skip");
    }
    if (includeLegacyAliases) {
        values.push(...resolveLegacyAuthChoiceAliasesForCli(params));
    }
    return values.join("|");
}
