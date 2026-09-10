import { compareProviderAuthChoiceGroups } from "./provider-auth-choice-order.js";
import {
  resolveManifestDeclaredProviderAuthChoices,
  type ProviderAuthChoiceMetadata,
} from "./provider-auth-choices.js";

export type ProviderLoginOption = {
  id: string;
  brandId: string;
  label: string;
  hint?: string;
  groupLabel?: string;
  icon?: string;
  website?: string;
  kind: "oauth" | "device-code" | "secret";
  featured: boolean;
};
export type ProviderChannelLoginChoice = {
  choiceId: string;
  pluginId: string;
  providerId: string;
  methodId: string;
  label: string;
  providerLabel: string;
  command: string;
  mode: "chat" | "secret" | "setup" | "sign-in";
};
export type ProviderOAuthLoginGroup = { pluginId: string; providerId: string; label: string };
export type ProviderChannelLoginResolution =
  | { status: "resolved"; choice: ProviderChannelLoginChoice }
  | { status: "providers"; providers: ProviderOAuthLoginGroup[] }
  | { status: "ambiguous" | "unsupported"; choices: ProviderChannelLoginChoice[] };

function supportsProviderAuthChoiceTextInference(
  scopes?: ProviderAuthChoiceMetadata["onboardingScopes"],
): boolean {
  return !scopes || scopes.includes("text-inference");
}

function isEligible(choice: ProviderAuthChoiceMetadata): boolean {
  return (
    Boolean(choice.choiceId.trim()) &&
    choice.assistantVisibility !== "manual-only" &&
    supportsProviderAuthChoiceTextInference(choice.onboardingScopes)
  );
}

function loginKind(choice: ProviderAuthChoiceMetadata): ProviderLoginOption["kind"] | undefined {
  if (!isEligible(choice) || choice.credentialOnly !== true || choice.appGuidedDiscovery) {
    return undefined;
  }
  return choice.appGuidedAuth ?? (choice.appGuidedSecret ? "secret" : undefined);
}

export function isProviderLoginChoiceStartable(choice: ProviderAuthChoiceMetadata): boolean {
  return loginKind(choice) !== undefined;
}

export function listProviderLoginOptions(
  choices: readonly ProviderAuthChoiceMetadata[],
): ProviderLoginOption[] {
  return choices
    .filter(isEligible)
    .toSorted(
      (a, b) =>
        Number(b.onboardingFeatured === true) - Number(a.onboardingFeatured === true) ||
        compareProviderAuthChoiceGroups(
          { id: a.groupId ?? a.providerId, label: a.groupLabel ?? a.choiceLabel },
          { id: b.groupId ?? b.providerId, label: b.groupLabel ?? b.choiceLabel },
        ) ||
        (a.assistantPriority ?? 0) - (b.assistantPriority ?? 0) ||
        a.choiceLabel.localeCompare(b.choiceLabel, "en") ||
        a.choiceId.localeCompare(b.choiceId),
    )
    .flatMap((choice): ProviderLoginOption[] => {
      const kind = loginKind(choice);
      if (!kind) {
        return [];
      }
      return [
        {
          id: formatProviderLoginChoiceRef(choice),
          brandId: choice.providerId,
          label: choice.choiceLabel,
          hint: choice.choiceHint,
          groupLabel: choice.groupLabel,
          icon: choice.icon,
          website: choice.website,
          kind,
          featured: choice.onboardingFeatured === true,
        },
      ];
    });
}

export function formatProviderLoginChoiceRef(
  choice: Pick<ProviderChannelLoginChoice, "pluginId" | "choiceId">,
): string {
  return `${encodeURIComponent(choice.pluginId)}/${encodeURIComponent(choice.choiceId)}`;
}

export function formatProviderOAuthLoginRef(
  provider: Pick<ProviderOAuthLoginGroup, "pluginId" | "providerId">,
): string {
  return `oauth/${encodeURIComponent(provider.pluginId)}/${encodeURIComponent(provider.providerId)}`;
}

function normalizeInput(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/_/gu, "-");
}

function projectChannelChoice(choice: ProviderAuthChoiceMetadata): ProviderChannelLoginChoice {
  const kind = loginKind(choice);
  return {
    choiceId: choice.choiceId,
    pluginId: choice.pluginId,
    providerId: choice.providerId,
    methodId: choice.methodId,
    label: choice.choiceLabel,
    providerLabel: choice.groupLabel ?? choice.choiceLabel,
    command: formatProviderLoginChoiceRef(choice),
    mode:
      choice.channelLogin && kind && choice.appGuidedAuth
        ? "chat"
        : kind === "secret"
          ? "secret"
          : kind
            ? "sign-in"
            : "setup",
  };
}

function readChoices(params?: Parameters<typeof resolveManifestDeclaredProviderAuthChoices>[0]) {
  return resolveManifestDeclaredProviderAuthChoices(params).filter(isEligible);
}

export function resolveProviderChannelLoginChoice(
  input: string | undefined,
  params?: Parameters<typeof resolveManifestDeclaredProviderAuthChoices>[0],
): ProviderChannelLoginResolution {
  const metadata = readChoices(params);
  const choices = metadata.map(projectChannelChoice);
  const raw = input?.trim() ?? "";
  const normalized = normalizeInput(input);
  const select = (matches: ProviderAuthChoiceMetadata[]): ProviderChannelLoginResolution => {
    const projected = matches.map(projectChannelChoice);
    return projected.length === 1
      ? { status: "resolved", choice: projected[0]! }
      : { status: "ambiguous", choices: projected };
  };
  const family = (choice: ProviderAuthChoiceMetadata): ProviderOAuthLoginGroup => ({
    pluginId: choice.pluginId,
    providerId: choice.groupId ?? choice.providerId,
    label: choice.groupLabel ?? choice.choiceLabel,
  });
  if (!normalized) {
    const providers = new Map<string, ProviderOAuthLoginGroup>();
    for (const choice of metadata) {
      if (choice.appGuidedAuth) {
        const group = family(choice);
        providers.set(formatProviderOAuthLoginRef(group), group);
      }
    }
    return {
      status: "providers",
      providers: [...providers.values()].toSorted(
        (a, b) =>
          a.label.localeCompare(b.label, "en") ||
          formatProviderOAuthLoginRef(a).localeCompare(formatProviderOAuthLoginRef(b)),
      ),
    };
  }
  if (raw.includes("/")) {
    const matches = metadata.filter(
      (choice) =>
        formatProviderLoginChoiceRef(choice) === raw ||
        (choice.appGuidedAuth !== undefined && formatProviderOAuthLoginRef(family(choice)) === raw),
    );
    return matches.length ? select(matches) : { status: "unsupported", choices };
  }
  const groups = metadata.filter(
    (choice) =>
      normalizeInput(choice.groupId) === normalized ||
      normalizeInput(choice.providerId) === normalized,
  );
  if (groups.length > 1) {
    return select(groups);
  }
  const exact = metadata.filter((choice) => normalizeInput(choice.choiceId) === normalized);
  if (exact.length) {
    return select(exact);
  }
  if (groups.length) {
    return select(groups);
  }
  const aliases = metadata.filter((choice) =>
    choice.channelLogin?.aliases?.some((alias) => normalizeInput(alias) === normalized),
  );
  return aliases.length ? select(aliases) : { status: "unsupported", choices };
}
