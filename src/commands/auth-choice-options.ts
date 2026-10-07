// Builds provider-aware auth-choice options and grouped onboarding menus.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderSetupFlowContributions } from "../flows/provider-flow.js";
import {
  compareProviderAuthChoiceGroups,
  isFeaturedProviderAuthChoiceGroup,
} from "../plugins/provider-auth-choice-order.js";
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

/** Keep the first-tier provider list stable; every other group belongs under More. */
export function isFeaturedAuthChoiceGroup(group: AuthChoiceGroup): boolean {
  return isFeaturedProviderAuthChoiceGroup(group.value);
}

function compareAssistantOptions(a: AuthChoiceOption, b: AuthChoiceOption): number {
  const priorityA = a.assistantPriority ?? 0;
  const priorityB = b.assistantPriority ?? 0;
  return priorityA - priorityB || compareOptionLabels(a, b);
}

/** Sort auth-choice groups with featured providers first, then stable labels. */
export function compareAuthChoiceGroups(a: AuthChoiceGroup, b: AuthChoiceGroup): number {
  return compareProviderAuthChoiceGroups(
    { id: a.value, label: a.label },
    { id: b.value, label: b.label },
  );
}

/**
 * Format every accepted `--auth-choice` value for CLI help and validation.
 *
 * This is the single owner of that set: help text, onboard preflight, and the
 * non-interactive dispatcher all render it, so an advertised value is always an
 * accepted one. Deprecated aliases stay out; `auth-choice-legacy.ts` normalizes
 * them before any surface sees them.
 */
export function formatAuthChoiceChoicesForCli(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const values = [
    ...formatStaticAuthChoiceChoicesForCli().split("|"),
    ...resolveProviderSetupFlowContributions({ ...params, scope: "all" }).map(
      (contribution) => contribution.option.value,
    ),
  ];

  return uniqueStrings(values).join("|");
}

/** Build grouped auth choices, filtering manual-only methods by default. */
export function buildAuthChoiceGroups(params: {
  includeSkip: boolean;
  assistantVisibleOnly?: boolean;
  detectedProviderIds?: ReadonlySet<string>;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): {
  groups: AuthChoiceGroup[];
  skipOption?: AuthChoiceOption;
} {
  const optionByValue = new Map<AuthChoice, AuthChoiceOption>();
  for (const option of CORE_AUTH_CHOICE_OPTIONS) {
    optionByValue.set(option.value, option);
  }
  for (const {
    option: { group, ...option },
    providerId,
  } of resolveProviderSetupFlowContributions({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    scope: "text-inference",
  })) {
    optionByValue.set(option.value, {
      ...option,
      providerId,
      ...(group
        ? {
            groupId: group.id,
            groupLabel: group.label,
            ...(group.hint ? { groupHint: group.hint } : {}),
          }
        : {}),
    });
  }

  const detectedProviders = new Set(
    [...(params.detectedProviderIds ?? [])].map(normalizeProviderId),
  );
  const options = Array.from(optionByValue.values())
    .toSorted(compareOptionLabels)
    .filter(
      (option) =>
        option.assistantVisibility !== "detected-only" ||
        (option.providerId !== undefined &&
          detectedProviders.has(normalizeProviderId(option.providerId))),
    )
    .filter((option) =>
      params.assistantVisibleOnly !== false ? option.assistantVisibility !== "manual-only" : true,
    );
  const groupsById = new Map<AuthChoiceGroupId, AuthChoiceGroup>();

  for (const option of options) {
    if (!option.groupId || !option.groupLabel) {
      continue;
    }
    const existing = groupsById.get(option.groupId);
    if (existing) {
      existing.options.push(option);
      if (option.providerId) {
        existing.providerIds = uniqueStrings([...(existing.providerIds ?? []), option.providerId]);
      }
      continue;
    }
    const providerIds = option.providerId ? [option.providerId] : [];
    groupsById.set(option.groupId, {
      value: option.groupId,
      label: option.groupLabel,
      ...(option.groupHint ? { hint: option.groupHint } : {}),
      ...(providerIds.length > 0 ? { providerIds } : {}),
      options: [option],
    });
  }
  const groups = Array.from(groupsById.values())
    .map((group) => {
      group.options = group.options.toSorted(compareAssistantOptions);
      return group;
    })
    .toSorted(compareAuthChoiceGroups);

  const skipOption = params.includeSkip
    ? ({ value: "skip", label: "Skip for now" } satisfies AuthChoiceOption)
    : undefined;

  return { groups, skipOption };
}
