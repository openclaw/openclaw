import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import type {
  ModelAuthStatusResult,
  ProviderLoginOption,
  SystemAgentSetupDetectResult,
} from "../../api/types.ts";
import { providerDisplayLabel } from "../../components/provider-icon-data.ts";
import { t } from "../../i18n/index.ts";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { resolveAgentModelPrimary } from "../../lib/agents/display.ts";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import { buildModelProviderCards } from "./data.ts";

registerModelSetupEnglish();

export type LoginChoice = Omit<ProviderLoginOption, "kind"> & {
  kind: ProviderLoginOption["kind"] | "setup-secret";
  authProvider: string;
};

type LoginProvider = {
  id: string;
  label: string;
  choices: LoginChoice[];
  authProviders: string[];
  apiKeyProvider?: string;
};

export function buildLoginProviders({
  providers,
  pluginId,
  authStatus,
  allowQuickApiKey,
  manualProviders,
}: {
  providers?: string[];
  pluginId?: string;
  authStatus?: ModelAuthStatusResult | null;
  allowQuickApiKey: boolean;
  manualProviders?: SystemAgentSetupDetectResult["manualProviders"];
}): LoginProvider[] {
  const groups = new Map<string, LoginProvider>();
  const choices = new Set<string>();
  const ensureGroup = (id: string, authProvider: string) => {
    const group: LoginProvider = groups.get(id) ?? {
      id,
      label: "",
      choices: [],
      authProviders: [],
    };
    if (!group.authProviders.includes(authProvider)) {
      group.authProviders.push(authProvider);
    }
    groups.set(id, group);
    return group;
  };
  for (const capability of authStatus?.providerCapabilities ?? []) {
    if (providers && !providers.includes(capability.provider)) {
      continue;
    }
    const loginOptions = capability.loginOptions ?? [];
    for (const option of loginOptions) {
      if (pluginId && option.pluginId !== pluginId) {
        continue;
      }
      const group = ensureGroup(option.brandId, capability.provider);
      group.label ||= option.groupLabel?.trim() ?? "";
      if (!choices.has(option.id)) {
        choices.add(option.id);
        group.choices.push({ ...option, authProvider: capability.provider });
      }
    }
    // Quick-key support is independent of wizard choices. Keep the exact
    // capability owner for the key form even when its login brand is an alias.
    if (!pluginId && capability.quickApiKeySetup && allowQuickApiKey) {
      const brands = loginOptions.length
        ? loginOptions.map((option) => option.brandId)
        : [capability.provider];
      for (const id of new Set(brands)) {
        const group = ensureGroup(id, capability.provider);
        group.apiKeyProvider ??= capability.provider;
        group.label ||= capability.quickApiKeyGroupLabel ?? "";
      }
    }
  }
  for (const option of (pluginId ? undefined : manualProviders) ?? []) {
    const id = option.brandId ?? option.id;
    if (choices.has(option.id) || (providers && !providers.includes(id))) {
      continue;
    }
    const group = ensureGroup(id, id);
    group.label ||= option.groupLabel?.trim() || option.label;
    const duplicateLabel = group.choices.some((choice) => choice.label === option.label);
    group.choices.push({
      ...option,
      brandId: id,
      authProvider: id,
      kind: "setup-secret",
      featured: false,
      ...(duplicateLabel
        ? {
            label: t("modelSetup.manual.accessValueFor", { provider: option.label }),
            hint: t("modelSetup.manual.accessValuePlaceholder"),
          }
        : {}),
    });
    choices.add(option.id);
  }
  for (const group of groups.values()) {
    group.label ||= providerDisplayLabel(group.id);
  }
  return [...groups.values()].toSorted(
    (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
}

export function loginProviderAccounts(
  provider: LoginProvider | undefined,
  authStatus: ModelAuthStatusResult | null | undefined,
) {
  return provider && authStatus
    ? buildModelProviderCards({ authStatus, models: null, providerUsage: null }).filter((card) =>
        provider.authProviders.some((owner) => card.id === canonicalModelAuthProviderId(owner)),
      )
    : [];
}

export function filterLoginProviders(groups: LoginProvider[], query: string): LoginProvider[] {
  const search = query.trim().toLocaleLowerCase().normalize("NFC");
  return groups.filter((group) =>
    [
      group.id,
      group.label,
      ...(group.apiKeyProvider ? [t("modelProviders.status.apiKey")] : []),
      ...group.choices.flatMap((choice) => [choice.label, choice.hint ?? ""]),
    ].some((text) => text.toLocaleLowerCase().normalize("NFC").includes(search)),
  );
}

export function resolveLoginSelection(
  config: Record<string, unknown> | null,
  agentId: string | null,
  authStatus?: ModelAuthStatusResult | null,
) {
  const modelRef = resolveAgentModelPrimary(config, agentId ?? "");
  if (!modelRef || !authStatus?.ts || authStatus.unavailable) {
    return { modelRef, missing: null };
  }
  const { model, profile } = splitTrailingAuthProfile(modelRef);
  const slash = model.indexOf("/");
  if (
    !profile ||
    slash < 1 ||
    authStatus.providers.some((provider) =>
      provider.profiles.some((candidate) => candidate.profileId === profile),
    )
  ) {
    return { modelRef, missing: null };
  }
  const modelProvider = normalizeProviderId(model.slice(0, slash));
  const authProvider =
    authStatus.providers.find(
      (provider) => normalizeProviderId(provider.provider) === modelProvider,
    )?.authProvider ?? modelProvider;
  return {
    modelRef,
    missing: { model, provider: canonicalModelAuthProviderId(modelProvider), authProvider },
  };
}
