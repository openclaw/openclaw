// Interactive grouped auth-choice prompt used by onboarding and agent setup.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter, WizardSelectOption } from "../wizard/prompts.js";
import {
  buildAuthChoiceGroups,
  compareAuthChoiceGroups,
  isFeaturedAuthChoiceGroup,
} from "./auth-choice-options.js";
import type { AuthChoiceGroup } from "./auth-choice-options.static.js";
import type { AuthChoice } from "./onboard-types.js";

const BACK_VALUE = "__back";
const MORE_VALUE = "__more";
const KEEP_CURRENT_AUTH_CHOICE = "__keep-current";

type KeepCurrentAuthChoice = typeof KEEP_CURRENT_AUTH_CHOICE;
type PromptAuthChoiceResult = AuthChoice | KeepCurrentAuthChoice;
type AuthChoiceOrBack = PromptAuthChoiceResult | typeof BACK_VALUE;
type PromptAuthChoiceGroupedParams = {
  prompter: WizardPrompter;
  includeSkip: boolean;
  assistantVisibleOnly?: boolean;
  allowedChoices?: ReadonlySet<string>;
  additionalGroups?: readonly AuthChoiceGroup[];
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowKeepCurrentProvider?: boolean;
  detectedProviderIds?: ReadonlySet<string>;
};

export function isKeepCurrentAuthChoice(value: unknown): value is KeepCurrentAuthChoice {
  return value === KEEP_CURRENT_AUTH_CHOICE;
}

function resolveConfiguredProvider(modelRef: string | undefined): string | undefined {
  const slashIndex = modelRef?.indexOf("/") ?? -1;
  if (!modelRef || slashIndex <= 0) {
    return undefined;
  }
  const provider = normalizeProviderId(modelRef.slice(0, slashIndex));
  return provider || undefined;
}

function groupMatchesProvider(group: AuthChoiceGroup, provider: string | undefined): boolean {
  if (!provider) {
    return false;
  }
  const candidates = [group.value, ...(group.providerIds ?? [])];
  return candidates.some((candidate) => normalizeProviderId(candidate) === provider);
}

function groupToOption(
  group: AuthChoiceGroup,
  configuredProvider: string | undefined,
  detectedProviderIds: ReadonlySet<string> | undefined,
): WizardSelectOption {
  const configured = groupMatchesProvider(group, configuredProvider);
  const detected = [...(detectedProviderIds ?? [])].some((provider) =>
    groupMatchesProvider(group, provider),
  );
  const statuses = [
    ...(detected ? ["detected"] : []),
    ...(configured ? ["currently configured"] : []),
  ];
  return {
    value: group.value,
    label: statuses.length > 0 ? `${group.label} (${statuses.join(", ")})` : group.label,
    hint: group.hint,
  };
}

/** Prompt for a provider group and auth method, with fallback flat selection when needed. */
export function promptAuthChoiceGrouped(
  params: PromptAuthChoiceGroupedParams & { allowKeepCurrentProvider: true },
): Promise<PromptAuthChoiceResult>;
export function promptAuthChoiceGrouped(params: PromptAuthChoiceGroupedParams): Promise<AuthChoice>;
export async function promptAuthChoiceGrouped(
  params: PromptAuthChoiceGroupedParams,
): Promise<PromptAuthChoiceResult> {
  const { groups, skipOption } = buildAuthChoiceGroups(params);
  const filteredGroups = params.allowedChoices
    ? groups.map((group) => ({
        ...group,
        options: group.options.filter((option) => params.allowedChoices?.has(option.value)),
      }))
    : groups;
  const availableBuiltInGroups = filteredGroups.filter((group) => group.options.length > 0);
  const additionalGroups = (params.additionalGroups ?? []).filter(
    (group) => group.options.length > 0,
  );
  const availableGroups = [...availableBuiltInGroups, ...additionalGroups];
  const groupById = new Map(availableGroups.map((group) => [group.value, group] as const));
  const isDetectedGroup = (group: AuthChoiceGroup) =>
    [...(params.detectedProviderIds ?? [])].some((provider) =>
      groupMatchesProvider(group, provider),
    );
  const detectedBuiltInGroups = availableBuiltInGroups
    .filter(isDetectedGroup)
    .toSorted(compareAuthChoiceGroups);
  // Caller-supplied groups carry pre-vetted context such as detected onboarding routes.
  // Keep them and reachable local providers ahead of the generic catalog.
  const featuredGroups = [
    ...additionalGroups,
    ...detectedBuiltInGroups,
    ...availableBuiltInGroups
      .filter((group) => !isDetectedGroup(group) && isFeaturedAuthChoiceGroup(group))
      .toSorted(compareAuthChoiceGroups),
  ];
  const moreGroups = availableBuiltInGroups
    .filter((group) => !isDetectedGroup(group) && !isFeaturedAuthChoiceGroup(group))
    .toSorted(compareAuthChoiceGroups);
  const configuredModelRef = resolveAgentModelPrimaryValue(params.config?.agents?.defaults?.model);
  const configuredProvider = params.allowKeepCurrentProvider
    ? resolveConfiguredProvider(configuredModelRef)
    : undefined;

  const pickMethod = async (group: AuthChoiceGroup): Promise<AuthChoiceOrBack> => {
    const keepCurrentOption = groupMatchesProvider(group, configuredProvider)
      ? ({
          value: KEEP_CURRENT_AUTH_CHOICE,
          label: "Keep current config",
          ...(configuredModelRef ? { hint: `Keep ${configuredModelRef}` } : {}),
        } satisfies WizardSelectOption<KeepCurrentAuthChoice>)
      : undefined;
    if (group.options.length === 1 && !keepCurrentOption) {
      return expectDefined(group.options[0], "options entry at 0").value;
    }
    return await params.prompter.select({
      message: group.methodMessage ?? `${group.label} auth method`,
      options: [
        ...(keepCurrentOption ? [keepCurrentOption] : []),
        ...group.options,
        { value: BACK_VALUE, label: "Back" },
      ],
    });
  };

  // Without featured providers, the searchable catalog is the root page.
  const hasFeaturedGroups = featuredGroups.length > 0;
  let showingMore = false;
  while (true) {
    const searchable = showingMore || !hasFeaturedGroups;
    const pageGroups = searchable ? moreGroups : featuredGroups;
    const options: WizardSelectOption[] = pageGroups.map((group) =>
      groupToOption(group, configuredProvider, params.detectedProviderIds),
    );
    if (showingMore) {
      options.push({ value: BACK_VALUE, label: "Back" });
    } else {
      if (hasFeaturedGroups && moreGroups.length > 0) {
        options.push({ value: MORE_VALUE, label: "More…" });
      }
      if (skipOption) {
        options.push({ value: skipOption.value, label: skipOption.label });
      }
    }
    const selection = await params.prompter.select({
      message: "Model/auth provider",
      options,
      ...(searchable ? { searchable: true } : {}),
    });
    if (showingMore && selection === BACK_VALUE) {
      showingMore = false;
      continue;
    }
    if (!showingMore && selection === "skip") {
      return "skip";
    }
    if (!showingMore && hasFeaturedGroups && selection === MORE_VALUE) {
      showingMore = true;
      continue;
    }
    const group = groupById.get(selection);
    if (!group || group.options.length === 0) {
      if (!showingMore) {
        await params.prompter.note(
          "No auth methods available for that provider.",
          "Model/auth choice",
        );
      }
      continue;
    }
    const method = await pickMethod(group);
    if (method !== BACK_VALUE) {
      return method;
    }
  }
}
