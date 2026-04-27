import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
// Regex pattern for template variables: {variableName} or {variable.name}
const TEMPLATE_VAR_PATTERN = /\{([a-zA-Z][a-zA-Z0-9.]*)\}/g;
/**
 * Interpolate template variables in a response prefix string.
 *
 * @param template - The template string with `{variable}` placeholders
 * @param context - Context object with values for interpolation
 * @returns The interpolated string, or undefined if template is undefined
 *
 * @example
 * resolveResponsePrefixTemplate("[{model} | think:{thinkingLevel}]", {
 *   model: "gpt-5.4",
 *   thinkingLevel: "high"
 * })
 * // Returns: "[gpt-5.4 | think:high]"
 */
export function resolveResponsePrefixTemplate(template, context) {
    if (!template) {
        return undefined;
    }
    return template.replace(TEMPLATE_VAR_PATTERN, (match, varName) => {
        const normalizedVar = normalizeLowercaseStringOrEmpty(varName);
        switch (normalizedVar) {
            case "model":
                return context.model ?? match;
            case "modelfull":
                return context.modelFull ?? match;
            case "provider":
                return context.provider ?? match;
            case "thinkinglevel":
            case "think":
                return context.thinkingLevel ?? match;
            case "identity.name":
            case "identityname":
                return context.identityName ?? match;
            default:
                // Leave unrecognized variables as-is
                return match;
        }
    });
}
/**
 * Extract short model name from a full model string.
 *
 * Strips:
 * - Provider prefix (e.g., "openai/" from "openai/gpt-5.4")
 * - Date suffixes (e.g., "-20260205" from "claude-opus-4-6-20260205")
 * - Common version suffixes (e.g., "-latest")
 *
 * @example
 * extractShortModelName("openai/gpt-5.5") // "gpt-5.5"
 * extractShortModelName("claude-opus-4-6-20260205") // "claude-opus-4-6"
 * extractShortModelName("gpt-5.4-latest") // "gpt-5.4"
 */
export function extractShortModelName(fullModel) {
    // Strip provider prefix
    const slash = fullModel.lastIndexOf("/");
    const modelPart = slash >= 0 ? fullModel.slice(slash + 1) : fullModel;
    // Strip date suffixes (YYYYMMDD format)
    return modelPart.replace(/-\d{8}$/, "").replace(/-latest$/, "");
}
/**
 * Check if a template string contains any template variables.
 */
export function hasTemplateVariables(template) {
    if (!template) {
        return false;
    }
    // Reset lastIndex since we're using a global regex
    TEMPLATE_VAR_PATTERN.lastIndex = 0;
    return TEMPLATE_VAR_PATTERN.test(template);
}
