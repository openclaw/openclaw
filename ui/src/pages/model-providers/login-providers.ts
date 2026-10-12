import type {
  ModelAuthStatusResult,
  ProviderLoginOption,
  SystemAgentSetupDetectResult,
} from "../../api/types.ts";
import { providerDisplayLabel } from "../../components/provider-icon.ts";
import { t } from "../../i18n/index.ts";

type LoginChoice = Omit<ProviderLoginOption, "kind"> & {
  kind: ProviderLoginOption["kind"] | "setup-secret";
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
  authStatus,
  allowQuickApiKey,
  manualProviders,
}: {
  providers?: string[];
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
    for (const option of capability.loginOptions ?? []) {
      const group = ensureGroup(option.brandId, capability.provider);
      group.label ||= option.groupLabel?.trim() ?? "";
      if (!choices.has(option.id)) {
        choices.add(option.id);
        group.choices.push(option);
      }
    }
    // Quick-key support is independent of wizard choices. Keep the exact
    // capability owner for the key form even when its login brand is an alias.
    if (capability.quickApiKeySetup && allowQuickApiKey) {
      const brands = capability.loginOptions?.length
        ? capability.loginOptions.map((option) => option.brandId)
        : [capability.provider];
      for (const id of new Set(brands)) {
        const group = ensureGroup(id, capability.provider);
        group.apiKeyProvider ??= capability.provider;
      }
    }
  }
  for (const option of manualProviders ?? []) {
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
