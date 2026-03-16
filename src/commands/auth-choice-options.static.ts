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
    label: "Chutes（OAuth）",
    groupId: "chutes",
    groupLabel: "Chutes",
    groupHint: "OAuth",
  },
  {
    value: "litellm-api-key",
    label: "LiteLLM API Key",
    hint: "100+ LLM 提供方统一网关",
    groupId: "litellm",
    groupLabel: "LiteLLM",
    groupHint: "统一 LLM 网关（100+ 提供方）",
  },
  {
    value: "custom-api-key",
    label: "自定义提供方",
    hint: "任意兼容 OpenAI 或 Anthropic 的端点",
    groupId: "custom",
    groupLabel: "自定义提供方",
    groupHint: "任意兼容 OpenAI 或 Anthropic 的端点",
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
