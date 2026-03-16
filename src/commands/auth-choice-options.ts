import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveProviderWizardOptions } from "../plugins/provider-wizard.js";
import {
  AUTH_CHOICE_GROUP_DEFS,
  BASE_AUTH_CHOICE_OPTIONS,
  type AuthChoiceGroup,
  type AuthChoiceOption,
  formatStaticAuthChoiceChoicesForCli,
} from "./auth-choice-options.static.js";
import type { AuthChoice, AuthChoiceGroupId } from "./onboard-types.js";

function resolveDynamicProviderCliChoices(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  return [...new Set(resolveProviderWizardOptions(params ?? {}).map((option) => option.value))];
}

export function formatAuthChoiceChoicesForCli(params?: {
  includeSkip?: boolean;
  includeLegacyAliases?: boolean;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const values = [
    ...formatStaticAuthChoiceChoicesForCli(params).split("|"),
    ...resolveDynamicProviderCliChoices(params),
  ];

  return values.join("|");
}

export function buildAuthChoiceOptions(params: {
  store: AuthProfileStore;
  includeSkip: boolean;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): AuthChoiceOption[] {
  void params.store;
  const optionByValue = new Map<AuthChoice, AuthChoiceOption>(
    BASE_AUTH_CHOICE_OPTIONS.map((option) => [option.value, option]),
  );

  for (const option of resolveProviderWizardOptions({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })) {
    optionByValue.set(option.value as AuthChoice, {
      value: option.value as AuthChoice,
      label: option.label,
      hint: option.hint,
    });
  }

  const options: AuthChoiceOption[] = Array.from(optionByValue.values());

  if (params.includeSkip) {
    options.push({ value: "skip", label: "Skip for now" });
  }

  return options;
}

export function buildAuthChoiceGroups(params: {
  store: AuthProfileStore;
  includeSkip: boolean;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): {
  groups: AuthChoiceGroup[];
  skipOption?: AuthChoiceOption;
} {
  const options = buildAuthChoiceOptions({
    ...params,
    includeSkip: false,
  });
  const optionByValue = new Map<AuthChoice, AuthChoiceOption>(
    options.map((opt) => [opt.value, opt]),
  );

  const groups: AuthChoiceGroup[] = AUTH_CHOICE_GROUP_DEFS.map((group) => ({
    ...group,
    options: group.choices
      .map((choice) => optionByValue.get(choice))
      .filter((opt): opt is AuthChoiceOption => Boolean(opt)),
  }));
  const staticGroupIds = new Set(groups.map((group) => group.value));

  for (const option of resolveProviderWizardOptions({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })) {
    const existing = groups.find((group) => group.value === option.groupId);
    const nextOption = optionByValue.get(option.value as AuthChoice) ?? {
      value: option.value as AuthChoice,
      label: option.label,
      hint: option.hint,
    };
    if (existing) {
      if (!existing.options.some((candidate) => candidate.value === nextOption.value)) {
        existing.options.push(nextOption);
      }
      continue;
    }
    if (staticGroupIds.has(option.groupId as AuthChoiceGroupId)) {
      continue;
    }
    groups.push({
      value: option.groupId as AuthChoiceGroupId,
      label: option.groupLabel,
      hint: option.groupHint,
      options: [nextOption],
    });
    staticGroupIds.add(option.groupId as AuthChoiceGroupId);
  }

  const skipOption = params.includeSkip
    ? ({ value: "skip", label: "Skip for now" } satisfies AuthChoiceOption)
    : undefined;

  return { groups, skipOption };
}
