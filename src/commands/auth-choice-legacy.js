import { resolveManifestDeprecatedProviderAuthChoice, resolveManifestProviderAuthChoices, } from "../plugins/provider-auth-choices.js";
function resolveLegacyCliBackendChoice(choice, params) {
    if (!choice.endsWith("-cli")) {
        return undefined;
    }
    return resolveManifestDeprecatedProviderAuthChoice(choice, params);
}
function resolveReplacementLabel(choiceLabel) {
    return choiceLabel.trim() || "the replacement auth choice";
}
export function resolveLegacyAuthChoiceAliasesForCli(params) {
    const manifestCliAliases = resolveManifestProviderAuthChoices(params)
        .flatMap((choice) => choice.deprecatedChoiceIds ?? [])
        .filter((choice) => choice.endsWith("-cli"))
        .toSorted((left, right) => left.localeCompare(right));
    return manifestCliAliases;
}
export function normalizeLegacyOnboardAuthChoice(authChoice, params) {
    if (authChoice === "oauth") {
        return "setup-token";
    }
    if (typeof authChoice === "string") {
        const deprecatedChoice = resolveLegacyCliBackendChoice(authChoice, params);
        if (deprecatedChoice) {
            return deprecatedChoice.choiceId;
        }
    }
    return authChoice;
}
export function isDeprecatedAuthChoice(authChoice, params) {
    return (typeof authChoice === "string" && Boolean(resolveLegacyCliBackendChoice(authChoice, params)));
}
export function resolveDeprecatedAuthChoiceReplacement(authChoice, params) {
    if (typeof authChoice !== "string") {
        return undefined;
    }
    const deprecatedChoice = resolveLegacyCliBackendChoice(authChoice, params);
    if (!deprecatedChoice) {
        return undefined;
    }
    const replacementLabel = resolveReplacementLabel(deprecatedChoice.choiceLabel);
    return {
        normalized: deprecatedChoice.choiceId,
        message: `Auth choice "${authChoice}" is deprecated; using ${replacementLabel} setup instead.`,
    };
}
export function formatDeprecatedNonInteractiveAuthChoiceError(authChoice, params) {
    const replacement = resolveDeprecatedAuthChoiceReplacement(authChoice, params);
    if (!replacement) {
        return undefined;
    }
    return [
        `Auth choice "${authChoice}" is deprecated.`,
        `Use "--auth-choice ${replacement.normalized}".`,
    ].join("\n");
}
