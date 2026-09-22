import { afterEach, expect, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type {
  ModelAuthStatusProvider,
  ModelAuthStatusResult,
  ModelCatalogResult,
  ModelsProbeResult,
} from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createGatewayMetadataObserver } from "../../app/gateway-observers.ts";
import type { SelectPicker } from "../../components/select-picker.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import type {
  RuntimeConfigExternalMutationOptions,
  RuntimeConfigExternalMutationResult,
} from "../../lib/config/config-gateway-operations.ts";
import {
  currentConfigObject,
  type RuntimeConfigState,
} from "../../lib/config/config-state-model.ts";
import {
  createRuntimeConfigCapability,
  type RuntimeConfigCapability,
} from "../../lib/config/runtime-config-capability.ts";
import { invalidateModelAuthStatusRequests } from "../../lib/model-auth-request-state.ts";
import { beginModelCatalogRead, publishModelCatalogResult } from "../../lib/model-catalog-cache.ts";
import { peekModelCatalog } from "../../lib/model-catalog-store.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { updatePickers } from "../../test-helpers/select-picker.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { ModelBehaviorConfig } from "./config-mutation.ts";
import type { DefaultModelSelection } from "./data.ts";
import { EMPTY_MODEL_PROVIDERS_DATA, type ModelProvidersData } from "./load.ts";
import type { ModelProviderProfileActionsController } from "./profile-actions-controller.ts";
import type { ModelProvidersRouteData } from "./route.ts";
import "./model-providers-page.ts";

const configOwners = new Set<RuntimeConfigCapability>();
afterEach(() => {
  for (const owner of configOwners) {
    owner.dispose();
  }
  configOwners.clear();
});

export type ModelProvidersPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
  busy: Record<string, boolean>;
  data: ModelProvidersData | null;
  addProvider: () => Promise<void>;
  addProviderId: string;
  addProviderKey: string;
  addProviderOpen: boolean;
  defaultsDraft: (DefaultModelSelection & Partial<ModelBehaviorConfig>) | null;
  keyDraft: string;
  keyEditorProvider: string | null;
  profileActions: Pick<ModelProviderProfileActionsController, "logout" | "setOrder">;
  messages: Record<string, { kind: "success" | "error"; text: string; warning?: string }>;
  profileOrders: Record<string, string[]>;
  probe: (cardId: string, providers: string[]) => Promise<void>;
  probeResults: Record<string, ModelsProbeResult>;
  refresh: (reason: "forced") => Promise<void>;
  routeData: ModelProvidersRouteData | undefined;
  requestUpdate: () => void;
  saveDefaults: () => Promise<void>;
  selectedAgentId: string;
};

export function modelPickers(page: Element): SelectPicker[] {
  return [
    ...page.querySelectorAll<SelectPicker>(".model-providers__defaults openclaw-select-picker"),
  ];
}

export function displayedCatalog(page: ModelProvidersPageTestElement) {
  return peekModelCatalog(
    page.context.gateway.snapshot.client!,
    { agentId: page.selectedAgentId },
    { allowStale: true },
  );
}

export function publishCatalog(
  context: ApplicationContext,
  agentId: string,
  result: ModelCatalogResult,
) {
  const client = context.gateway.snapshot.client!;
  const scope = { agentId };
  expect(publishModelCatalogResult(beginModelCatalogRead(client, scope), scope, result)).toBe(true);
}

export async function openModelPicker(page: HTMLElement, index = 0): Promise<void> {
  await updatePickers(page);
  const picker = modelPickers(page)[index];
  expect(picker).toBeDefined();
  const trigger = picker!.querySelector<HTMLButtonElement>(".picker-select__trigger");
  expect(trigger).not.toBeNull();
  if (trigger!.getAttribute("aria-expanded") === "true") {
    trigger!.click();
    await picker!.updateComplete;
  }
  trigger!.click();
  await picker!.updateComplete;
}

export function createAuthStatus(
  providers: Partial<ModelAuthStatusProvider>[] = [{}],
  ts = 1,
): ModelAuthStatusResult {
  return {
    ts,
    providers: providers.map((overrides): ModelAuthStatusProvider => ({
      provider: "openai",
      displayName: "OpenAI",
      status: "ok",
      profiles: [
        { profileId: "openai:one", type: "oauth", status: "ok" },
        { profileId: "openai:two", type: "oauth", status: "ok" },
      ],
      ...overrides,
    })),
  };
}

export function createApiKeyProviderData(): ModelProvidersData {
  return {
    ...EMPTY_MODEL_PROVIDERS_DATA,
    authStatus: {
      ...createAuthStatus([
        {
          profiles: [
            { profileId: "openai:key", type: "api_key", status: "static", logoutSupported: true },
          ],
        },
      ]),
      providerCapabilities: [{ provider: "openai", apiKeySupported: true, quickApiKeySetup: true }],
    },
  };
}

export async function saveKey(page: ModelProvidersPageTestElement, value: string) {
  page.data = createApiKeyProviderData();
  page.keyEditorProvider = "openai";
  page.keyDraft = value;
  await page.updateComplete;
  page.querySelector<HTMLButtonElement>(".model-providers__inline-form button")!.click();
}

export function createHarness(initialScopeId: string) {
  let pendingAuthStatus: Promise<void> | null = null;
  let releaseAuthStatus: (() => void) | null = null;
  const deferNextAuthStatus = () => {
    pendingAuthStatus = new Promise<void>((resolve) => {
      releaseAuthStatus = resolve;
    });
    return () => releaseAuthStatus?.();
  };
  let usageStatus: unknown = { updatedAt: 1, providers: [] };
  let usageStatusRejects = false;
  const request = vi.fn(async (method: string): Promise<unknown> => {
    switch (method) {
      case "models.authStatus": {
        if (pendingAuthStatus) {
          const gate = pendingAuthStatus;
          pendingAuthStatus = null;
          await gate;
        }
        return {
          ts: 1,
          providers: [],
          providerCapabilities: [
            { provider: "anthropic", apiKeySupported: true, quickApiKeySetup: true },
          ],
        };
      }
      case "models.list":
        return { models: [] };
      case "config.get":
        return {
          config: { agents: { defaults: { thinkingDefault: "low", fastModeDefault: "auto" } } },
          hash: "hash",
          valid: true,
        };
      case "usage.status":
        if (usageStatusRejects) {
          throw new Error("usage.status unavailable");
        }
        return usageStatus;
      case "sessions.usage":
        return { aggregates: { byProvider: [] } };
      default:
        return {};
    }
  });
  const snapshot: ApplicationGatewaySnapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: {
        methods: [
          "config.get",
          "config.patch",
          "config.set",
          "config.apply",
          "models.list",
          "models.authStatus",
          "models.probe",
          "models.authSetApiKey",
          "models.authLogout",
          "models.authOrderSet",
          "models.authLogin",
          "usage.status",
          "sessions.usage",
          "wizard.start",
          "wizard.next",
          "wizard.cancel",
          "wizard.status",
        ],
      },
    },
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const gatewaySource = createApplicationGateway(snapshot);
  const metadata = createGatewayMetadataObserver(
    (current) => current === gatewaySource.gateway.snapshot,
  );
  let previousSnapshot = { ...snapshot };
  gatewaySource.gateway.subscribe((next) => {
    const previous = previousSnapshot;
    previousSnapshot = { ...next };
    metadata.synchronize(previous, next);
  });
  let selectionListener: (() => void) | undefined;
  const settingsAgentSelection = {
    intentRevision: 0,
    state: {
      selectedId: initialScopeId as string | null,
      scopeId: initialScopeId as string | null,
    },
    set: vi.fn(),
    setScope: vi.fn(),
    subscribe(listener: () => void) {
      selectionListener = listener;
      return () => {
        selectionListener = undefined;
      };
    },
  };
  const runtimeConfigListeners = new Set<(state: RuntimeConfigState) => void>();
  const subscribe = () => () => undefined;
  const owner = createRuntimeConfigCapability(gatewaySource.gateway);
  configOwners.add(owner);
  const subscribeConfig = owner.subscribe.bind(owner);
  const runExternalMutation = owner.runExternalMutation;
  const runtimeConfig = Object.assign(owner, {
    ensureLoaded: vi.fn(owner.ensureLoaded),
    patch: vi.fn(async () => true),
    beforeExternalDispatch: vi.fn(async (): Promise<void> => undefined),
    runExternalMutation: vi.fn(
      async <T>(
        task: (client: GatewayBrowserClient) => Promise<T>,
        options: RuntimeConfigExternalMutationOptions<T> = {},
      ): Promise<RuntimeConfigExternalMutationResult<T>> => {
        await runtimeConfig.beforeExternalDispatch();
        return await runExternalMutation(task, options);
      },
    ),
    patchForm: vi.fn(),
    removeFormValue: vi.fn(),
    refresh: vi.fn(owner.refresh),
    save: vi.fn(async () => true),
    apply: vi.fn(async () => true),
    discardDraft: vi.fn(async () => undefined),
    subscribe(listener: (state: RuntimeConfigState) => void) {
      runtimeConfigListeners.add(listener);
      const release = subscribeConfig(listener);
      return () => {
        runtimeConfigListeners.delete(listener);
        release();
      };
    },
  });
  const context = {
    gateway: gatewaySource.gateway,
    agents: {
      state: {
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          scope: "project",
          agents: [
            { id: "main", name: "Main" },
            { id: "writer", name: "Writer" },
          ],
        },
        agentsLoading: false,
        agentsError: null as string | null,
      },
      ensureList: vi.fn(),
      refreshList: vi.fn(),
      subscribe,
    },
    settingsAgentSelection,
    agentSelection: {
      state: { selectedId: "main", scopeId: "main" },
      subscribe: () => () => undefined,
    },
    runtimeConfig,
    overlays: {
      snapshot: { updateRunning: false, updateReconciliationPending: false },
      subscribe,
    },
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  return {
    settingsAgentSelection,
    context,
    gatewaySource,
    deferNextAuthStatus,
    notifySelection: () => selectionListener?.(),
    notifyRuntimeConfig: () => {
      for (const listener of runtimeConfigListeners) {
        listener(runtimeConfig.state);
      }
    },
    publishEvent: (event: GatewayEventFrame) => {
      // The app invalidates shared facts before delivering publication events to pages.
      if (
        snapshot.client &&
        (event.event === "config.changed" || event.event === "chat.metadata.changed")
      ) {
        invalidateModelAuthStatusRequests(snapshot.client);
        invalidateChatMetadataStore(snapshot.client);
      }
      if (event.event === "config.changed" && !runtimeConfig.state.configFormDirty) {
        void runtimeConfig.refresh();
      }
      gatewaySource.publishEvent(event);
    },
    request,
    runtimeConfig,
    snapshot,
    publishPhase: (phase: ApplicationGatewaySnapshot["phase"]) => {
      snapshot.phase = phase;
      gatewaySource.publish({ ...snapshot });
    },
    setUsageStatus: (value: unknown) => {
      usageStatus = value;
    },
    failUsageStatus: () => {
      usageStatusRejects = true;
    },
  };
}

export function requestCount(request: ReturnType<typeof vi.fn>, method: string): number {
  return request.mock.calls.filter(([candidate]) => candidate === method).length;
}

export async function waitForProviders(
  page: ModelProvidersPageTestElement,
  expectedConfig?: Record<string, unknown>,
): Promise<void> {
  await page.context.runtimeConfig.ensureLoaded();
  await waitForFast(() => {
    expect(page.data?.updatedAt).toEqual(expect.any(Number));
    expect(page.context.runtimeConfig.state.configLoading).toBe(false);
    if (expectedConfig) {
      expect(currentConfigObject(page.context.runtimeConfig.state)).toEqual(expectedConfig);
    }
  });
}

export async function advanceUsageRetries(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await vi.advanceTimersByTimeAsync(5_000);
  }
}

export function focusDocument(): void {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
}

export function createEmptyModelProvidersRouteData(
  context: ApplicationContext,
): ModelProvidersRouteData {
  // A loader completed before connection; the connected page now owns recovery.
  return {
    gateway: context.gateway,
    gatewaySnapshot: { ...context.gateway.snapshot, phase: "stopped", client: null },
    data: EMPTY_MODEL_PROVIDERS_DATA,
    client: null,
    agentId: context.settingsAgentSelection.state.selectedId,
    selectionIntentRevision: context.settingsAgentSelection.intentRevision,
  };
}

export function appendPage(context: ApplicationContext) {
  const page = document.createElement(
    "openclaw-model-providers-page",
  ) as ModelProvidersPageTestElement;
  page.context = context;
  page.routeData = createEmptyModelProvidersRouteData(context);
  document.body.append(page);
  return page;
}
