import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveManifestProviderAuthChoices } from "../plugins/provider-auth-choices.js";
import { resolveProviderWizardOptions } from "../plugins/provider-wizard.js";
import {
  CORE_AUTH_CHOICE_OPTIONS,
  type AuthChoiceGroup,
  type AuthChoiceOption,
  formatStaticAuthChoiceChoicesForCli,
} from "./auth-choice-options.static.js";
import type { AuthChoice, AuthChoiceGroupId } from "./onboard-types.js";

function compareOptionLabels(a: AuthChoiceOption, b: AuthChoiceOption): number {
  return a.label.localeCompare(b.label);
}

function compareGroupLabels(a: AuthChoiceGroup, b: AuthChoiceGroup): number {
  return a.label.localeCompare(b.label);
}

function resolveManifestProviderChoiceOptions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): AuthChoiceOption[] {
  return resolveManifestProviderAuthChoices(params ?? {}).map((choice) => ({
    value: choice.choiceId as AuthChoice,
    label: choice.choiceLabel,
    ...(choice.choiceHint ? { hint: choice.choiceHint } : {}),
    ...(choice.groupId ? { groupId: choice.groupId as AuthChoiceGroupId } : {}),
    ...(choice.groupLabel ? { groupLabel: choice.groupLabel } : {}),
    ...(choice.groupHint ? { groupHint: choice.groupHint } : {}),
  }));
}

function resolveRuntimeFallbackProviderChoiceOptions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): AuthChoiceOption[] {
  return resolveProviderWizardOptions(params ?? {}).map((option) => ({
    value: option.value as AuthChoice,
    label: option.label,
    ...(option.hint ? { hint: option.hint } : {}),
    groupId: option.groupId as AuthChoiceGroupId,
    groupLabel: option.groupLabel,
    ...(option.groupHint ? { groupHint: option.groupHint } : {}),
  }));
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
    ...resolveManifestProviderChoiceOptions(params).map((option) => option.value),
  ];

  return [...new Set(values)].join("|");
}

export function buildAuthChoiceOptions(params: {
  store: AuthProfileStore;
  includeSkip: boolean;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): AuthChoiceOption[] {
  void params.store;
  const optionByValue = new Map<AuthChoice, AuthChoiceOption>();
  for (const option of CORE_AUTH_CHOICE_OPTIONS) {
    optionByValue.set(option.value, option);
  }
  for (const option of resolveManifestProviderChoiceOptions({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })) {
    optionByValue.set(option.value, option);
  }
  for (const option of resolveRuntimeFallbackProviderChoiceOptions({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })) {
    if (!optionByValue.has(option.value)) {
      optionByValue.set(option.value, option);
    }
  }

  const options: AuthChoiceOption[] = Array.from(optionByValue.values()).toSorted(
    compareOptionLabels,
  );

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
  const groupsById = new Map<AuthChoiceGroupId, AuthChoiceGroup>();

  for (const option of options) {
    if (!option.groupId || !option.groupLabel) {
      continue;
    }
    const existing = groupsById.get(option.groupId);
    if (existing) {
      existing.options.push(option);
      continue;
    }
    groupsById.set(option.groupId, {
      value: option.groupId,
      label: option.groupLabel,
      ...(option.groupHint ? { hint: option.groupHint } : {}),
      options: [option],
    });
  }
  const groups = Array.from(groupsById.values())
    .map((group) => ({
      ...group,
      options: [...group.options].toSorted(compareOptionLabels),
    }))
    .toSorted(compareGroupLabels);

  const skipOption = params.includeSkip
    ? ({ value: "skip", label: "Skip for now" } satisfies AuthChoiceOption)
    : undefined;

  return { groups, skipOption };
}
