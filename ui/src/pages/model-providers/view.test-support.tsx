import { createSignal } from "solid-js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { ModelProviderCard } from "./data.ts";
import { ModelProviders, type ModelProvidersViewProps } from "./view.tsx";

const mountedViews = new WeakMap<HTMLElement, (props: ModelProvidersViewProps) => void>();

export function card(overrides: Partial<ModelProviderCard> = {}): ModelProviderCard {
  return {
    id: "openai",
    displayName: "OpenAI",
    profiles: [],
    profileProviderIds: {},
    profileOrders: {},
    profileOrderStoredProviders: [],
    profileOrderExplicitProviders: [],
    profileOrderLocks: {},
    credentialProviderIds: ["openai"],
    logoutTargets: [],
    hasConfigApiKey: false,
    modelCount: 1,
    availableModelCount: 1,
    apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
    ...overrides,
  };
}

export function props(overrides: Partial<ModelProvidersViewProps> = {}): ModelProvidersViewProps {
  return {
    connected: true,
    loading: false,
    refreshing: false,
    error: null,
    providerUsageFailed: false,
    supplementalLoading: false,
    updatedAt: 1,
    credentialAgentLabel: "Writer",
    cards: [card()],
    configuredModels: [{ id: "openai/gpt-5", provider: "openai", name: "GPT-5", available: true }],
    decisionModels: [],
    defaultModels: { primary: "openai/gpt-5", fallbacks: [], utilityModel: null },
    thinkingLevel: "off",
    thinkingOverridden: true,
    fastMode: false,
    fastModeOverridden: true,
    catalogDiscovering: false,
    catalogDiscoveryError: null,
    configBusy: false,
    unconfiguredProviders: [{ id: "anthropic", displayName: "Anthropic" }],
    canViewProfiles: true,
    canMutate: true,
    mutationBlockedReason: null,
    defaultsMutationBlockedReason: null,
    providerUsageStalled: false,
    probeAvailable: true,
    busy: {},
    messages: {},
    probeResults: {},
    keyEditorProvider: null,
    keyDraft: "",
    profileOrders: {},
    addProviderOpen: false,
    addProviderId: "",
    addProviderKey: "",
    installedAgents: undefined,
    onRefresh: () => undefined,
    onOpenKeyEditor: () => undefined,
    onCloseKeyEditor: () => undefined,
    onKeyDraftChange: () => undefined,
    onSaveKey: () => undefined,
    onRemoveKey: () => undefined,
    onProbe: () => undefined,
    onRequestLogout: () => undefined,
    onProfileOrderChange: () => undefined,
    onAddProviderToggle: () => undefined,
    onAddProviderKeyChange: () => undefined,
    onAddProvider: () => undefined,
    onPrimaryChange: () => undefined,
    onFallbackChange: () => undefined,
    onUtilityChange: () => undefined,
    onDecisionChange: () => undefined,
    onThinkingChange: () => undefined,
    onThinkingReset: () => undefined,
    onFastModeChange: () => undefined,
    onFastModeReset: () => undefined,
    onCatalogRetry: () => undefined,
    onConnectProvider: () => undefined,
    onConnect: () => undefined,
    canConnect: () => false,
    loginBusy: false,
    ...overrides,
  };
}

export function mount(viewProps: ModelProvidersViewProps, container?: HTMLElement): HTMLElement {
  const update = container && mountedViews.get(container);
  if (container && update) {
    update({ ...viewProps });
    flush();
    return container;
  }
  const [current, setCurrent] = createSignal(viewProps);
  const view = mountSolid(() => <ModelProviders {...current()} />, { container });
  mountedViews.set(view.container, (next) => setCurrent(next));
  flush();
  return view.container;
}

export function text(element: Element | null): string {
  return element?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}
