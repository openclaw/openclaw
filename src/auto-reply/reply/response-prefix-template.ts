// Resolves response-prefix templates for channel and sender scoped replies.

export type ResponsePrefixContext = {
  /** Short model name (e.g., "gpt-5.4", "claude-opus-4-6") */
  model?: string;
  /** Full model ID including provider. */
  modelFull?: string;
  /** Provider name (e.g., "openai", "anthropic") */
  provider?: string;
  /** Current thinking level (e.g., "high", "low", "off") */
  thinkingLevel?: string;
  /** Agent identity name */
  identityName?: string;
};

// Regex pattern for template variables: {variableName} or {variable.name}
const TEMPLATE_VAR_PATTERN = /\{([a-zA-Z][a-zA-Z0-9.]*)\}/g;
const TEMPLATE_FIELDS: Readonly<Record<string, keyof ResponsePrefixContext>> = {
  model: "model",
  modelfull: "modelFull",
  provider: "provider",
  thinkinglevel: "thinkingLevel",
  think: "thinkingLevel",
  "identity.name": "identityName",
  identityname: "identityName",
};

/** Variable names are case-insensitive; unresolved placeholders remain literal. */
export function resolveResponsePrefixTemplate(
  template: string | undefined,
  context: ResponsePrefixContext,
): string | undefined {
  if (!template) {
    return undefined;
  }

  return template.replace(TEMPLATE_VAR_PATTERN, (match, varName: string) => {
    const normalizedVar = varName.toLowerCase();
    return Object.hasOwn(TEMPLATE_FIELDS, normalizedVar)
      ? (context[TEMPLATE_FIELDS[normalizedVar]!] ?? match)
      : match;
  });
}

/** Strips the provider prefix, date suffix, and trailing -latest tag for display. */
export function extractShortModelName(fullModel: string): string {
  const slash = fullModel.lastIndexOf("/");
  const modelPart = slash >= 0 ? fullModel.slice(slash + 1) : fullModel;

  return modelPart.replace(/-\d{8}$/, "").replace(/-latest$/, "");
}
