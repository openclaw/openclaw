import { render as mountSolid } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { onTestFinished } from "vitest";
import type { ModelProviderCard } from "./data.ts";
import { ModelProviders, type ModelProvidersViewProps } from "./view.tsx";

const mountedViews = new WeakMap<HTMLDivElement, (props: ModelProvidersViewProps) => void>();

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

export function mount(
  viewProps: ModelProvidersViewProps,
  container = document.body.appendChild(document.createElement("div")),
): HTMLDivElement {
  const update = mountedViews.get(container);
  if (update) {
    update({ ...viewProps });
  } else {
    const [current, setCurrent] = createSignal(viewProps);
    const view = mountSolid(() => <ModelProviders {...current()} />, { container });
    mountedViews.set(container, (next) => setCurrent(next));
    onTestFinished(() => {
      view.unmount();
      mountedViews.delete(container);
      container.remove();
    });
  }
  flush();
  return container;
}

export function text(element: Element | null): string {
  return element?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}
