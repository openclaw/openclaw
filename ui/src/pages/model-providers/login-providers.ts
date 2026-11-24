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
import { hasProviderAccounts } from "./profiles-view.tsx";

registerModelSetupEnglish();

export type LoginChoice = Omit<ProviderLoginOption, "kind"> & {
  kind: ProviderLoginOption["kind"] | "setup-secret";
  authProvider: string;
};

export type LoginProvider = {
  id: string;
  label: string;
  choices: LoginChoice[];
  authProviders: string[];
  apiKeyProvider?: string;
  /** Setup suggests this provider first. */
  featured?: true;
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
    const brands = new Set(
      loginOptions.length ? loginOptions.map((option) => option.brandId) : [capability.provider],
    );
    // Quick-key support is independent of wizard choices. Keep the exact
    // capability owner for the key form even when its login brand is an alias.
    if (!pluginId && capability.quickApiKeySetup && allowQuickApiKey) {
      for (const id of brands) {
        const group = ensureGroup(id, capability.provider);
        group.apiKeyProvider ??= capability.provider;
        group.label ||= capability.quickApiKeyGroupLabel ?? "";
      }
    }
    for (const id of brands) {
      const group = groups.get(id);
      if (group && (capability.featured || group.choices.some((choice) => choice.featured))) {
        group.featured = true;
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

type ModelConnectionIntent = Pick<
  import("./route.ts").ModelProvidersRouteData,
  "connect" | "pluginId" | "provider"
>;

export function pendingModelConnection<T extends ModelConnectionIntent>(
  next: T,
  previous: T | undefined,
  pending: T | null,
): T | null {
  return next.connect !== previous?.connect ||
    next.pluginId !== previous?.pluginId ||
    next.provider !== previous?.provider
    ? next.connect
      ? next
      : null
    : pending;
}

export function connectAction(
  intent: ModelConnectionIntent | null,
  login: Pick<import("./login-controller.ts").ModelProviderLogin, "busy" | "open">,
  search: HTMLInputElement | undefined,
  authStatus: ModelAuthStatusResult | null | undefined,
): (() => void) | undefined {
  if (!intent) {
    return undefined;
  }
  const { pluginId, provider: providerId } = intent;
  if (pluginId) {
    return login.busy ? undefined : () => void login.open(undefined, { pluginId });
  }
  if (providerId) {
    const provider = canonicalModelAuthProviderId(providerId);
    const groups = buildLoginProviders({ authStatus, allowQuickApiKey: true });
    const group =
      groups.find((entry) => entry.id === providerId) ??
      groups.find((entry) => canonicalModelAuthProviderId(entry.id) === provider) ??
      groups.find((entry) =>
        entry.authProviders.some((id) => canonicalModelAuthProviderId(id) === provider),
      );
    if (group) {
      return login.busy
        ? undefined
        : () => void login.open(group.authProviders, { select: group.id });
    }
  }
  if (search) {
    return () => {
      search.scrollIntoView({ block: "center" });
      search.focus({ preventScroll: true });
    };
  }
  return undefined;
}

/** Saved accounts this agent can already use with one login provider. */
export function providerAccounts(group: LoginProvider, authStatus?: ModelAuthStatusResult | null) {
  return authStatus
    ? buildModelProviderCards({ authStatus, models: null, providerUsage: null }).filter((card) =>
        group.authProviders.some((owner) => card.id === canonicalModelAuthProviderId(owner)),
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

/** One way in and nothing saved: the method step would be a single button, so skip it. */
export function directEntry(
  group: LoginProvider,
  authStatus?: ModelAuthStatusResult | null,
): { apiKeyProvider: string } | { choice: LoginChoice } | null {
  if (authStatus?.unavailable || hasProviderAccounts(providerAccounts(group, authStatus))) {
    return null;
  }
  if (group.apiKeyProvider && !group.choices.length) {
    return { apiKeyProvider: group.apiKeyProvider };
  }
  return !group.apiKeyProvider && group.choices.length === 1 ? { choice: group.choices[0]! } : null;
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
