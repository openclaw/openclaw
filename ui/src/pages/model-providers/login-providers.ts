import type {
  ModelAuthStatusResult,
  ProviderLoginOption,
  ProviderSetupOption,
} from "../../api/types.ts";
import { providerDisplayLabel } from "../../components/provider-icon.ts";

type ProviderLoginGroup = {
  id: string;
  label: string;
  choices: ProviderLoginOption[];
  setupChoices: ProviderSetupOption[];
  authProviders: string[];
  apiKeyProvider?: string;
};

export function buildProviderLoginGroups({
  capabilities,
  providers,
  includeApiKey,
}: {
  capabilities: ModelAuthStatusResult["providerCapabilities"];
  providers?: readonly string[];
  includeApiKey: boolean;
}): ProviderLoginGroup[] {
  const groups = new Map<string, ProviderLoginGroup>();
  const choices = new Set<string>();
  const groupFor = (
    option: Pick<ProviderSetupOption, "brandId" | "groupId" | "groupLabel">,
    provider: string,
  ) => {
    const id = option.groupId ?? option.brandId;
    let group = groups.get(id);
    if (!group) {
      group = { id, label: "", choices: [], setupChoices: [], authProviders: [] };
      groups.set(group.id, group);
    }
    group.label ||= option.groupLabel?.trim() ?? "";
    if (!group.authProviders.includes(provider)) {
      group.authProviders.push(provider);
    }
    return group;
  };
  for (const capability of capabilities ?? []) {
    for (const option of capability.loginOptions ?? []) {
      const group = groupFor(option, capability.provider);
      if (!choices.has(option.id)) {
        choices.add(option.id);
        group.choices.push(option);
      }
    }
    for (const option of capability.setupOptions ?? []) {
      const group = groupFor(option, capability.provider);
      if (!choices.has(option.id)) {
        choices.add(option.id);
        group.setupChoices.push(option);
      }
    }
    // Quick-key support is independent of wizard choices. Keep the exact
    // capability owner for the key form even when its login brand is an alias.
    if (capability.quickApiKeySetup && includeApiKey) {
      const options = [...(capability.loginOptions ?? []), ...(capability.setupOptions ?? [])];
      for (const option of options.length ? options : [{ brandId: capability.provider }]) {
        groupFor(option, capability.provider).apiKeyProvider ??= capability.provider;
      }
    }
  }
  for (const group of groups.values()) {
    group.label ||= providerDisplayLabel(group.id);
    if (group.authProviders.length > 1) {
      delete group.apiKeyProvider;
    }
  }
  return [...groups.values()]
    .filter(
      (group) =>
        !providers || providers.some((id) => group.id === id || group.authProviders.includes(id)),
    )
    .toSorted((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}
