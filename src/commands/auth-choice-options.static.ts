import { AUTH_CHOICE_LEGACY_ALIASES_FOR_CLI } from "./auth-choice-legacy.js";
import type { AuthChoice, AuthChoiceGroupId } from "./onboard-types.js";

export type { AuthChoiceGroupId };

export type AuthChoiceOption = {
  value: AuthChoice;
  label: string;
  hint?: string;
  groupId?: AuthChoiceGroupId;
  groupLabel?: string;
  groupHint?: string;
};

export type AuthChoiceGroup = {
  value: AuthChoiceGroupId;
  label: string;
  hint?: string;
  options: AuthChoiceOption[];
};

export const CORE_AUTH_CHOICE_OPTIONS: ReadonlyArray<AuthChoiceOption> = [
  {
    value: "chutes",
    label: "Chutes (OAuth)",
    groupId: "chutes",
    groupLabel: "Chutes",
    groupHint: "OAuth",
  },
  {
    value: "puter-web",
    label: "Puter web login",
    hint: "Open browser, sign in, then paste API key",
    groupId: "puter",
    groupLabel: "Puter",
    groupHint: "Web login or API key",
  },
  {
    value: "puter-api-key",
    label: "Puter API key",
    groupId: "puter",
    groupLabel: "Puter",
    groupHint: "Web login or API key",
  },
  {
    value: "litellm-api-key",
    label: "LiteLLM API key",
    hint: "Unified gateway for 100+ LLM providers",
    groupId: "litellm",
    groupLabel: "LiteLLM",
    groupHint: "Unified LLM gateway (100+ providers)",
  },
  {
    value: "custom-api-key",
    label: "Custom Provider",
    hint: "Any OpenAI or Anthropic compatible endpoint",
    groupId: "custom",
    groupLabel: "Custom Provider",
    groupHint: "Any OpenAI or Anthropic compatible endpoint",
  },
];

export function formatStaticAuthChoiceChoicesForCli(params?: {
  includeSkip?: boolean;
  includeLegacyAliases?: boolean;
}): string {
  const includeSkip = params?.includeSkip ?? true;
  const includeLegacyAliases = params?.includeLegacyAliases ?? false;
  const values = CORE_AUTH_CHOICE_OPTIONS.map((opt) => opt.value);

  if (includeSkip) {
    values.push("skip");
  }
  if (includeLegacyAliases) {
    values.push(...AUTH_CHOICE_LEGACY_ALIASES_FOR_CLI);
  }

  return values.join("|");
}
