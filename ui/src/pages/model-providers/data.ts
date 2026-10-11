import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import type {
  ProviderUsageSnapshot,
  UsageSummary,
} from "../../../../src/infra/provider-usage.types.js";
import type { SessionModelUsage } from "../../../../src/infra/session-cost-usage.types.js";
import type {
  AgentsListResult,
  FastMode,
  ModelAuthStatusProvider,
  ModelAuthStatusProfile,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  ModelCatalogProviderOutcome,
} from "../../api/types.ts";
import { providerDisplayLabel } from "../../components/provider-icon.ts";
import { listSelectableAgents, normalizeAgentLabel } from "../../lib/agents/display.ts";
import {
  canonicalModelAuthProviderId,
  isMonitoredAuthProvider,
  listEffectiveModelAuthProviders,
} from "../../lib/model-auth.ts";
import type { ModelCatalogPresentation } from "../../lib/model-catalog-store.ts";
import type { ProviderUsageRequestResult } from "../../lib/provider-usage-request.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";

export type ModelProviderAuthKind = "ok" | "expiring" | "expired" | "missing" | "api-key";

type ModelProviderAuthSummary = {
  kind: ModelProviderAuthKind;
  expiryLabel?: string;
};

type ModelProviderLocalCost = {
  totalCost: number;
  totalTokens: number;
  messageCount: number;
};

export type ModelProviderLogoutTarget = {
  provider: string;
  profileIds: string[];
};

export type ModelProviderPendingLogout = {
  cardId: string;
  label: string;
  target: ModelProviderLogoutTarget;
};

type ModelProviderProfileOrderLock = NonNullable<ModelAuthStatusProvider["profileOrderLocked"]>;

export type ModelProviderCard = {
  /** Canonical provider id used for icon + label lookup. */
  id: string;
  /** Exact config map key; provider ids are otherwise normalized for display/runtime use. */
  configKey?: string;
  configAuthMode?: string;
  apiKeySupported?: boolean;
  /** Provider ids that own credentials merged into this card. */
  credentialProviderIds: string[];
  /** Saved OAuth/token profiles eligible for targeted logout. */
  logoutTargets: ModelProviderLogoutTarget[];
  displayName: string;
  auth?: ModelProviderAuthSummary;
  profiles: ModelAuthStatusProfile[];
  /** Gateway auth owner used for priority changes to each visible profile. */
  profileProviderIds: Record<string, string>;
  /** Explicit priority, or inventory order while selection is automatic, by auth owner. */
  profileOrders: Record<string, string[]>;
  /** Auth owners with explicit priority, including inherited and configured orders. */
  profileOrderExplicitProviders: string[];
  /** Auth owners whose stored priority can be reset. */
  profileOrderStoredProviders: string[];
  /** Configuration owner that pins priority for each auth owner. */
  profileOrderLocks: Record<string, ModelProviderProfileOrderLock>;
  apiKey?: ModelAuthStatusProvider["apiKey"];
  hasConfigApiKey: boolean;
  modelCount: number;
  availableModelCount: number;
  catalogStatus?: ModelCatalogProviderOutcome["status"];
  checkingModels?: boolean;
  /** Live provider-reported usage (quota windows, billing, cost history). */
  usage?: ProviderUsageSnapshot;
  /** Locally-computed session spend for the requested window. */
  localCost?: ModelProviderLocalCost;
};

type ConfiguredModelProvider = { key: string; hasApiKey: boolean; authMode?: string };

type ModelProviderCardsInput = {
  authStatus: ModelAuthStatusResult | null;
  models: ModelCatalogEntry[] | null;
  providerOutcomes?: ModelCatalogProviderOutcome[];
  pendingProviders?: readonly string[];
  configProviders?: ConfiguredModelProvider[];
  providerUsage: UsageSummary | null;
  costByProvider: SessionModelUsage[] | null;
};

type CardDraft = {
  ids: Set<string>;
  card: ModelProviderCard;
  hasModelAuth: boolean;
  catalogOutcome?: ModelCatalogProviderOutcome;
};

const CATALOG_OUTCOME_PRIORITY = {
  provider: ["auth-rejected", "unavailable", "ready"],
  profile: ["ready", "auth-rejected", "unavailable"],
} as const;

function findDraft(drafts: CardDraft[], ids: string[]): CardDraft | undefined {
  return drafts.find((draft) => ids.some((id) => draft.ids.has(id)));
}

function ensureDraft(drafts: CardDraft[], id: string, displayName: string): CardDraft {
  const existing = findDraft(drafts, [id]);
  if (existing) {
    return existing;
  }
  const draft: CardDraft = {
    ids: new Set([id]),
    card: {
      id,
      displayName,
      profiles: [],
      profileProviderIds: {},
      profileOrders: {},
      profileOrderExplicitProviders: [],
      profileOrderStoredProviders: [],
      profileOrderLocks: {},
      credentialProviderIds: [],
      logoutTargets: [],
      hasConfigApiKey: false,
      modelCount: 0,
      availableModelCount: 0,
    },
    hasModelAuth: false,
  };
  drafts.push(draft);
  return draft;
}

function addProviderId(ids: string[], provider: string): void {
  const normalized = normalizeProviderId(provider);
  if (normalized && !ids.some((candidate) => normalizeProviderId(candidate) === normalized)) {
    ids.push(provider);
  }
}

function addLogoutTarget(
  targets: ModelProviderLogoutTarget[],
  provider: string,
  profileIds: string[],
): void {
  if (profileIds.length === 0) {
    return;
  }
  const normalized = normalizeProviderId(provider);
  const existing = targets.find(
    (candidate) => normalizeProviderId(candidate.provider) === normalized,
  );
  if (!existing) {
    targets.push({ provider, profileIds: [...new Set(profileIds)] });
    return;
  }
  existing.profileIds = [...new Set([...existing.profileIds, ...profileIds])];
}

/**
 * Builds the provider card list. A provider qualifies as "configured" when it
 * has model-provider auth, catalog models (the default models.list view only contains
 * configured or auth-backed entries), a live usage snapshot, or recorded
 * local spend. Model presence alone is enough: a configured API-key provider
 * with a broken credential reports available=false and no auth row, and the
 * page must surface that state rather than hide the provider.
 */
export function buildModelProviderCards(input: ModelProviderCardsInput): ModelProviderCard[] {
  const drafts: CardDraft[] = [];
  const providerDraft = (provider: string, displayName?: string) => {
    const id = canonicalModelAuthProviderId(provider);
    return id ? ensureDraft(drafts, id, displayName || providerDisplayLabel(id)) : undefined;
  };
  const apiKeyCapabilities = new Map<string, boolean>();
  const profileOrdersByAuthProvider = new Map<string, string[]>();
  const explicitOrderProviders = new Set<string>();
  for (const capability of input.authStatus?.providerCapabilities ?? []) {
    const id = canonicalModelAuthProviderId(capability.provider);
    if (!id) {
      continue;
    }
    apiKeyCapabilities.set(id, apiKeyCapabilities.get(id) === true || capability.apiKeySupported);
  }

  for (const provider of input.configProviders ?? []) {
    const card = providerDraft(provider.key)?.card;
    if (!card) {
      continue;
    }
    card.configKey ??= provider.key;
    if (provider.hasApiKey) {
      card.configKey = provider.key;
      card.hasConfigApiKey = true;
      addProviderId(card.credentialProviderIds, provider.key);
    }
    if (provider.authMode !== undefined) {
      card.configAuthMode = provider.authMode;
    }
  }

  for (const provider of input.pendingProviders ?? []) {
    const draft = providerDraft(provider);
    if (draft) {
      draft.card.checkingModels = true;
    }
  }

  for (const outcome of input.providerOutcomes ?? []) {
    const draft = providerDraft(outcome.provider);
    if (!draft) {
      continue;
    }
    const current = draft.catalogOutcome;
    const providerWide = outcome.profileId === undefined;
    const priority = CATALOG_OUTCOME_PRIORITY[providerWide ? "provider" : "profile"];
    // Unscoped diagnostics own the provider card. Within profile-scoped results,
    // one ready profile keeps a rejected sibling from hiding the usable catalog.
    if (
      !current ||
      (providerWide !== (current.profileId === undefined)
        ? providerWide
        : priority.indexOf(outcome.status) < priority.indexOf(current.status))
    ) {
      draft.catalogOutcome = outcome;
    }
  }

  for (const entry of input.models ?? []) {
    const draft = providerDraft(entry.provider);
    if (!draft) {
      continue;
    }
    draft.card.modelCount += 1;
    if (entry.available === true) {
      draft.card.availableModelCount += 1;
    }
  }

  for (const provider of input.authStatus?.providers ?? []) {
    const id = canonicalModelAuthProviderId(provider.provider);
    if (!id) {
      continue;
    }
    // The usage embed names the id the payload was fetched under; keep both
    // ids matchable in case it diverges from the static alias table.
    const canonicalId = provider.usage
      ? canonicalModelAuthProviderId(provider.usage.providerId)
      : id;
    const ids = [...new Set([id, canonicalId])];
    const existing = findDraft(drafts, ids);
    // Fresh cards adopt the canonical usage id so icon/label lookups resolve
    // brand assets (claude-cli would miss the anthropic icon alias).
    const draft = existing ?? ensureDraft(drafts, canonicalId, providerDisplayLabel(canonicalId));
    for (const candidate of ids) {
      draft.ids.add(candidate);
    }
    draft.card.displayName = provider.displayName || draft.card.displayName;
    draft.card.profiles.push(...provider.profiles);
    if (provider.profiles.length > 0) {
      const authProvider = provider.authProvider || provider.provider;
      for (const profile of provider.profiles) {
        draft.card.profileProviderIds[profile.profileId] = authProvider;
      }
      if (provider.profileOrder !== undefined) {
        explicitOrderProviders.add(authProvider);
      }
      const order = provider.profileOrder ?? provider.profiles.map((profile) => profile.profileId);
      profileOrdersByAuthProvider.set(authProvider, [
        ...new Set([...(profileOrdersByAuthProvider.get(authProvider) ?? []), ...order]),
      ]);
      draft.card.profileOrders[authProvider] = order;
      if (
        provider.profileOrderStored === true &&
        !draft.card.profileOrderStoredProviders.includes(authProvider)
      ) {
        draft.card.profileOrderStoredProviders.push(authProvider);
      }
      if (provider.profileOrderLocked !== undefined) {
        draft.card.profileOrderLocks[authProvider] ??= provider.profileOrderLocked;
      }
    }
    if (provider.apiKey || provider.profiles.length > 0) {
      addProviderId(draft.card.credentialProviderIds, provider.provider);
    }
    addLogoutTarget(
      draft.card.logoutTargets,
      provider.provider,
      provider.profiles
        .filter((profile) => profile.logoutSupported === true)
        .map((profile) => profile.profileId),
    );
    draft.card.apiKey ??= provider.apiKey;
    // Generic auth discovery also includes tool-only API keys; those alone do not make a model card.
    draft.hasModelAuth ||= isMonitoredAuthProvider(provider) || apiKeyCapabilities.has(id);
    const usage = provider.usage;
    if (usage && !draft.card.usage) {
      draft.card.usage = {
        provider: usage.providerId,
        displayName: provider.displayName,
        windows: usage.windows,
        ...(usage.summary ? { summary: usage.summary } : {}),
        ...(usage.plan ? { plan: usage.plan } : {}),
        ...(usage.billing?.length ? { billing: usage.billing } : {}),
      };
    }
  }

  for (const draft of drafts) {
    draft.card.profileOrderExplicitProviders = Object.keys(draft.card.profileOrders).filter(
      (provider) => explicitOrderProviders.has(provider),
    );
    for (const authProvider of Object.keys(draft.card.profileOrders)) {
      const completeOrder = profileOrdersByAuthProvider.get(authProvider);
      if (completeOrder) {
        draft.card.profileOrders[authProvider] = completeOrder;
      }
    }
  }

  for (const provider of listEffectiveModelAuthProviders(input.authStatus?.providers ?? [])) {
    const draft = findDraft(drafts, [canonicalModelAuthProviderId(provider.provider)]);
    if (draft) {
      draft.card.auth = {
        kind: provider.status === "static" ? "api-key" : provider.status,
        ...(provider.expiry?.label ? { expiryLabel: provider.expiry.label } : {}),
      };
    }
  }

  for (const snapshot of input.providerUsage?.providers ?? []) {
    const draft = providerDraft(snapshot.provider, snapshot.displayName);
    if (!draft) {
      continue;
    }
    // usage.status snapshots carry cost history and errors that the
    // auth-status embed drops, so they win when both are present.
    draft.card.usage = snapshot;
  }

  for (const entry of input.costByProvider ?? []) {
    const draft = providerDraft(entry.provider ?? "");
    if (!draft) {
      continue;
    }
    const cost = (draft.card.localCost ??= { totalCost: 0, totalTokens: 0, messageCount: 0 });
    cost.totalCost += entry.totals.totalCost;
    cost.totalTokens += entry.totals.totalTokens;
    cost.messageCount += entry.count;
  }

  return drafts
    .filter(
      (draft) =>
        draft.hasModelAuth ||
        (input.configProviders ?? []).some(
          ({ key }) => canonicalModelAuthProviderId(key) === draft.card.id,
        ) ||
        Boolean(draft.card.usage) ||
        draft.card.modelCount > 0 ||
        Boolean(draft.catalogOutcome) ||
        draft.card.checkingModels ||
        (draft.card.localCost?.totalTokens ?? 0) > 0,
    )
    .map((draft) => {
      const apiKeySupported = apiKeyCapabilities.get(draft.card.id);
      return Object.assign(
        {},
        draft.card,
        draft.catalogOutcome ? { catalogStatus: draft.catalogOutcome.status } : {},
        apiKeySupported === undefined ? {} : { apiKeySupported },
      );
    })
    .toSorted((a, b) => a.displayName.localeCompare(b.displayName));
}

export type DefaultModelSelection = {
  primary: string;
  fallbacks: string[];
  /** null = automatic/unset; empty string = explicitly disabled. */
  utilityModel: string | null;
  /** Unset or null disables decisions globally. */
  decisionModel?: string | null;
};

export type ModelPickerEntry = ModelCatalogEntry & { selectionRef?: string };
export type ModelBehaviorConfig = {
  thinkingLevel: string | undefined;
  thinkingOverridden: boolean;
  fastMode: FastMode | undefined;
  fastModeOverridden: boolean;
};
export type DefaultsDraft = DefaultModelSelection & ModelBehaviorConfig;

export function resolveDefaultModelPresentation(
  catalog: ModelCatalogPresentation,
  configured: DefaultsDraft,
  draft: DefaultsDraft | null,
): { defaults: DefaultsDraft; configuredModels: ModelPickerEntry[] } {
  if (catalog.retired || catalog.modelSelectionPolicy?.restricted) {
    return {
      defaults: {
        ...configured,
        primary: catalog.modelSelectionPolicy?.defaultModel ?? "",
        fallbacks: [],
        utilityModel: null,
        decisionModel: null,
      },
      configuredModels: catalog.models.filter((model) => model.manualSelectionAllowed !== false),
    };
  }
  const defaults = draft ?? configured;
  return {
    defaults,
    configuredModels: buildSelectableDefaultModels(
      catalog.hasSnapshot ? catalog.models : null,
      defaults,
    ),
  };
}

export function modelCatalogRef(model: ModelPickerEntry): string {
  if (model.selectionRef !== undefined) {
    return model.selectionRef;
  }
  return model.id.startsWith(`${model.provider}/`) ? model.id : `${model.provider}/${model.id}`;
}

function buildSelectableDefaultModels(
  models: ModelCatalogEntry[] | null,
  selection: DefaultModelSelection,
): ModelPickerEntry[] {
  const selected = new Set<string>(
    [selection.primary, ...selection.fallbacks, selection.utilityModel].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  const selectable: ModelPickerEntry[] = (models ?? []).filter(
    (model) => model.available !== false || selected.has(modelCatalogRef(model)),
  );
  const seen = new Set(selectable.map(modelCatalogRef));
  // An unavailable catalog cannot establish that a saved model is unavailable.
  const availability = models === null ? {} : { available: false as const };
  for (const ref of selected) {
    if (seen.has(ref)) {
      continue;
    }
    const { model: modelRef, profile } = splitTrailingAuthProfile(ref);
    if (profile) {
      const match = (models ?? []).find((model) => modelCatalogRef(model) === modelRef);
      if (match) {
        selectable.push({ ...match, selectionRef: ref });
        continue;
      }
    }
    const slash = ref.indexOf("/");
    if (slash <= 0 || slash === ref.length - 1) {
      const normalized = ref.trim().toLowerCase();
      const match = (models ?? []).find(
        (model) =>
          model.alias?.trim().toLowerCase() === normalized || model.id.trim() === ref.trim(),
      );
      selectable.push({
        ...(match ?? { provider: "", id: ref, name: ref, ...availability }),
        selectionRef: ref,
      });
      continue;
    }
    selectable.push({
      provider: ref.slice(0, slash),
      id: ref.slice(slash + 1),
      name: ref,
      ...availability,
    });
  }
  return selectable;
}

export function readModelProviderConfig(config: Record<string, unknown> | null): {
  providers: ConfiguredModelProvider[];
  defaults: DefaultModelSelection;
} {
  const models = asRecord(config?.models);
  const providers = asRecord(models?.providers);
  const agents = asRecord(config?.agents);
  const defaults = asRecord(agents?.defaults);
  const model = defaults?.model;
  const modelObject = asRecord(model);
  const primary =
    typeof model === "string"
      ? model
      : typeof modelObject?.primary === "string"
        ? modelObject.primary
        : "";
  const fallbacks = Array.isArray(modelObject?.fallbacks)
    ? modelObject.fallbacks.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    providers: Object.entries(providers ?? {}).map(([key, value]) => {
      const provider = asRecord(value);
      const entry: ConfiguredModelProvider = {
        key,
        hasApiKey: provider ? Object.hasOwn(provider, "apiKey") && provider.apiKey != null : false,
      };
      if (typeof provider?.auth === "string") {
        entry.authMode = provider.auth;
      }
      return entry;
    }),
    defaults: {
      primary,
      fallbacks,
      utilityModel: typeof defaults?.utilityModel === "string" ? defaults.utilityModel : null,
      ...(typeof defaults?.decisionModel === "string"
        ? { decisionModel: defaults.decisionModel }
        : {}),
    },
  };
}

export type ProviderOption = { id: string; displayName: string };

type ModelProviderCapability = NonNullable<ModelAuthStatusResult["providerCapabilities"]>[number];

export function buildUnconfiguredProviderOptions(
  capabilities: ModelProviderCapability[] | undefined,
  configuredProviderIds: Iterable<string>,
): ProviderOption[] {
  const configured = new Set(Array.from(configuredProviderIds, canonicalModelAuthProviderId));
  const options = new Map<string, ProviderOption>();
  for (const capability of capabilities ?? []) {
    const id = canonicalModelAuthProviderId(capability.provider);
    if (capability.quickApiKeySetup && id && !configured.has(id) && !options.has(id)) {
      options.set(id, { id, displayName: providerDisplayLabel(id) });
    }
  }
  return [...options.values()].toSorted((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Assembles admitted snapshots for the Models page without owning state or effects. */
export function buildModelProviderPresentation(params: {
  configObject: Record<string, unknown> | null;
  behavior: ModelBehaviorConfig;
  catalog: ModelCatalogPresentation;
  data: Omit<
    ModelProviderCardsInput,
    "models" | "configProviders" | "pendingProviders" | "providerUsage"
  > & {
    providerUsage: ProviderUsageRequestResult | null;
  };
  agentsState: { agentsList: AgentsListResult | null; agentsError: string | null };
  agentId: string;
  defaultsDraft: DefaultsDraft | null;
}) {
  const { catalog, data, agentsState, agentId } = params;
  const agents = agentsState.agentsList?.agents ?? [];
  const noSelectableAgents =
    agentsState.agentsList !== null && listSelectableAgents(agents).length === 0;
  const rosterError = agentsState.agentsList ? null : agentsState.agentsError;
  const selected = agents.find((agent) => normalizeAgentId(agent.id) === agentId);
  const config = readModelProviderConfig(params.configObject);
  const configuredDefaults = { ...config.defaults, ...params.behavior };
  const { defaults, configuredModels } = resolveDefaultModelPresentation(
    catalog,
    configuredDefaults,
    params.defaultsDraft,
  );
  const cards = buildModelProviderCards({
    ...data,
    models: catalog.models,
    providerOutcomes: catalog.hasSnapshot
      ? (catalog.providerOutcomes ?? [])
      : data.providerOutcomes,
    pendingProviders: catalog.pendingProviders,
    providerUsage: data.providerUsage?.ok ? data.providerUsage.value : null,
    configProviders: config.providers,
  });
  const configuredProviderIds = new Set([
    ...config.providers.map(({ key }) => key),
    ...(data.authStatus?.providers
      .filter((provider) => Boolean(provider.apiKey) || provider.profiles.length > 0)
      .map((provider) => provider.provider) ?? []),
  ]);
  return {
    configuredDefaults,
    cards,
    noSelectableAgents,
    rosterError,
    agentLabel: selected ? normalizeAgentLabel(selected) : agentId,
    values: {
      configuredModels,
      defaultModels: defaults,
      decisionModels: catalog.decisionModels ?? [],
      authStatus: data.authStatus,
      automaticUtilityModel: catalog.defaultModels?.automaticUtilityModel,
      utilityRuntime: catalog.defaultModels?.utilityRuntime,
      thinkingLevel: defaults.thinkingLevel,
      thinkingOverridden: defaults.thinkingOverridden,
      fastMode: defaults.fastMode,
      fastModeOverridden: defaults.fastModeOverridden,
      unconfiguredProviders: buildUnconfiguredProviderOptions(
        data.authStatus?.providerCapabilities,
        configuredProviderIds,
      ),
    },
  };
}
