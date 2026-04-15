import { resolveLegacyAuthChoiceAliasesForCli } from "./auth-choice-legacy.js";
import type { AuthChoice, AuthChoiceGroupId } from "./onboard-types.js";

export type { AuthChoiceGroupId };

export type AuthChoiceOption = {
  value: AuthChoice;
  label: string;
  hint?: string;
  groupId?: AuthChoiceGroupId;
  groupLabel?: string;
  groupHint?: string;
  assistantPriority?: number;
  assistantVisibility?: "visible" | "manual-only";
};

export type AuthChoiceGroup = {
  value: AuthChoiceGroupId;
  label: string;
  hint?: string;
  options: AuthChoiceOption[];
};

export const CORE_AUTH_CHOICE_OPTIONS: ReadonlyArray<AuthChoiceOption> = [
  {
    value: "custom-api-key",
    label: "Custom Provider",
    hint: "Any OpenAI or Anthropic compatible endpoint",
    groupId: "custom",
    groupLabel: "Custom Provider",
    groupHint: "Any OpenAI or Anthropic compatible endpoint",
  },
  {
    value: "codexbar",
    label: "CodexBar",
    hint: "Use CodexBar as your LM provider manager",
    groupId: "codexbar",
    groupLabel: "CodexBar (External LM Manager)",
    groupHint: "Skip LM config — manage providers via CodexBar after setup",
  },
];

export function formatStaticAuthChoiceChoicesForCli(params?: {
  includeSkip?: boolean;
  includeLegacyAliases?: boolean;
  config?: import("../config/config.js").OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
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
