import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { compareProviderAuthChoiceGroups } from "../plugins/provider-auth-choice-order.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import type { ProviderInstallCatalogEntry } from "../plugins/provider-install-catalog.js";

type SetupInferenceOptionPresentation = {
  /** Provider-auth choice id sent back to the selected setup operation. */
  id: string;
  /** Canonical provider identity for clients with bundled brand artwork. */
  brandId?: string;
  label: string;
  hint?: string;
  icon?: string;
  website?: string;
};

export type SetupInferenceManualProvider = SetupInferenceOptionPresentation & {
  /** Provider family shown above the specific credential method. */
  groupLabel?: string;
};

export type SetupInferenceAuthOption = SetupInferenceOptionPresentation & {
  kind: "oauth" | "device-code" | "install" | "custom";
  featured: boolean;
  groupLabel?: string;
};

type ChoicePresentationSource = Pick<
  ProviderAuthChoiceMetadata,
  "choiceId" | "providerId" | "choiceLabel" | "choiceHint" | "icon" | "website"
>;

function projectChoicePresentation(
  choice: ChoicePresentationSource,
  id = choice.choiceId.trim(),
): SetupInferenceOptionPresentation {
  return {
    id,
    brandId: choice.providerId,
    label: choice.choiceLabel,
    ...(choice.choiceHint?.trim() ? { hint: choice.choiceHint.trim() } : {}),
    ...(choice.icon ? { icon: choice.icon } : {}),
    ...(choice.website ? { website: choice.website } : {}),
  };
}

function compareSetupInferenceOptions(
  a: SetupInferenceOptionPresentation & { featured?: boolean; groupLabel?: string },
  b: SetupInferenceOptionPresentation & { featured?: boolean; groupLabel?: string },
): number {
  return (
    Number(b.featured) - Number(a.featured) ||
    compareProviderAuthChoiceGroups(
      { id: a.brandId ?? a.id, label: a.groupLabel ?? a.label },
      { id: b.brandId ?? b.id, label: b.groupLabel ?? b.label },
    ) ||
    a.label.localeCompare(b.label, "en") ||
    a.id.localeCompare(b.id, "en")
  );
}

function listSetupInferenceGuidedOptions<
  TOption extends SetupInferenceOptionPresentation & { featured?: boolean },
>(params: {
  choices: readonly ProviderAuthChoiceMetadata[];
  include: (choice: ProviderAuthChoiceMetadata) => boolean;
  project: (choice: ProviderAuthChoiceMetadata, id: string) => TOption;
}): TOption[] {
  const options = new Map<string, { metadata: ProviderAuthChoiceMetadata; option: TOption }>();
  for (const choice of params.choices) {
    const id = choice.choiceId.trim();
    if (
      !id ||
      options.has(id) ||
      !supportsSetupTextInference(choice.onboardingScopes) ||
      !params.include(choice)
    ) {
      continue;
    }
    options.set(id, { metadata: choice, option: params.project(choice, id) });
  }
  return [...options.values()]
    .toSorted(
      (a, b) =>
        Number(b.option.featured) - Number(a.option.featured) ||
        compareProviderAuthChoiceGroups(
          {
            id: a.metadata.groupId ?? a.metadata.providerId,
            label: a.metadata.groupLabel ?? a.metadata.choiceLabel,
          },
          {
            id: b.metadata.groupId ?? b.metadata.providerId,
            label: b.metadata.groupLabel ?? b.metadata.choiceLabel,
          },
        ) ||
        (a.metadata.assistantPriority ?? 0) - (b.metadata.assistantPriority ?? 0) ||
        a.option.label.localeCompare(b.option.label, "en") ||
        a.option.id.localeCompare(b.option.id, "en"),
    )
    .map(({ option }) => option);
}

export function listSetupInferenceInstallOptions(
  entries: readonly ProviderInstallCatalogEntry[],
  installedChoices: readonly ProviderAuthChoiceMetadata[],
): SetupInferenceAuthOption[] {
  const installed = new Set(installedChoices.map((choice) => choice.choiceId));
  const options = new Map<string, SetupInferenceAuthOption>();
  for (const entry of entries) {
    if (
      installed.has(entry.choiceId) ||
      options.has(entry.choiceId) ||
      !supportsSetupTextInference(entry.onboardingScopes)
    ) {
      continue;
    }
    options.set(entry.choiceId, {
      ...projectChoicePresentation({
        choiceId: entry.choiceId,
        providerId: entry.providerId,
        choiceLabel: entry.choiceLabel,
        choiceHint: entry.choiceHint,
      }),
      ...(entry.groupLabel?.trim() ? { groupLabel: entry.groupLabel.trim() } : {}),
      kind: "install",
      featured: false,
    });
  }
  return [...options.values()].toSorted(compareSetupInferenceOptions);
}

export type SetupInferencePrepareOption = SetupInferenceOptionPresentation & {
  actionLabel?: string;
};

export function supportsSetupTextInference(
  scopes?: ProviderAuthChoiceMetadata["onboardingScopes"],
): boolean {
  return !scopes || scopes.includes("text-inference");
}

export function supportsSetupManualSecret(choice: ProviderAuthChoiceMetadata): boolean {
  return supportsSetupTextInference(choice.onboardingScopes) && choice.appGuidedSecret === true;
}

export function listSetupInferenceManualProviders(
  authChoices: readonly ProviderAuthChoiceMetadata[],
): SetupInferenceManualProvider[] {
  const choices = new Map<string, SetupInferenceManualProvider>();
  for (const choice of authChoices) {
    const id = choice.choiceId.trim();
    if (!id || choices.has(id) || !supportsSetupManualSecret(choice)) {
      continue;
    }
    choices.set(id, {
      ...projectChoicePresentation(choice, id),
      ...(choice.groupLabel?.trim() ? { groupLabel: choice.groupLabel.trim() } : {}),
    });
  }
  return [...choices.values()].toSorted(compareSetupInferenceOptions);
}

export function listSetupInferenceAuthOptions(
  authChoices: readonly ProviderAuthChoiceMetadata[],
): SetupInferenceAuthOption[] {
  return listSetupInferenceGuidedOptions({
    choices: authChoices,
    include: (choice) =>
      Boolean(choice.appGuidedAuth) ||
      (choice.appGuidedSecret !== true && choice.appGuidedDiscovery !== true),
    project: (choice, id) => ({
      ...projectChoicePresentation(choice, id),
      ...(choice.groupLabel?.trim() ? { groupLabel: choice.groupLabel.trim() } : {}),
      kind: choice.appGuidedAuth ?? "install",
      featured: choice.onboardingFeatured === true,
    }),
  });
}

export function listSetupInferenceEnableOptions(
  choices: readonly ProviderAuthChoiceMetadata[],
): SetupInferenceAuthOption[] {
  return choices
    .filter((choice) => supportsSetupTextInference(choice.onboardingScopes))
    .map((choice) => {
      const option: SetupInferenceAuthOption = Object.assign(
        projectChoicePresentation(choice, choice.choiceId),
        {
          kind: "install",
          featured: choice.onboardingFeatured === true,
        } as const,
      );
      const groupLabel = choice.groupLabel?.trim();
      if (groupLabel) {
        option.groupLabel = groupLabel;
      }
      return option;
    })
    .toSorted(compareSetupInferenceOptions);
}

export function listSetupInferencePrepareOptions(
  authChoices: readonly ProviderAuthChoiceMetadata[],
): SetupInferencePrepareOption[] {
  return listSetupInferenceGuidedOptions({
    choices: authChoices,
    include: (choice) => choice.appGuidedDiscovery === true,
    project: (choice, id) => ({
      ...projectChoicePresentation(choice, id),
      ...(choice.appGuidedActionLabel?.trim()
        ? { actionLabel: choice.appGuidedActionLabel.trim() }
        : {}),
    }),
  });
}

export function choiceMatchesCredential(
  choice: ProviderAuthChoiceMetadata,
  credential: AuthProfileCredential,
): boolean {
  return (
    normalizeProviderId(choice.providerId) === normalizeProviderId(credential.provider) &&
    supportsSetupTextInference(choice.onboardingScopes) &&
    (credential.type === "oauth" ? Boolean(choice.appGuidedAuth) : choice.appGuidedSecret === true)
  );
}
