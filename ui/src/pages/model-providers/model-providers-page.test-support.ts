import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ModelAuthStatusProvider,
  ModelAuthStatusResult,
  ModelsProbeResult,
} from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type {
  RuntimeConfigExternalMutationOptions,
  RuntimeConfigExternalMutationResult,
} from "../../lib/config/config-gateway-operations.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import type { ModelBehaviorConfig } from "./config-mutation.ts";
import type { DefaultModelSelection } from "./data.ts";
import { EMPTY_MODEL_PROVIDERS_DATA, type ModelProvidersData } from "./load.ts";
import type { ModelProviderProfileActionsController } from "./profile-actions-controller.ts";
import type { ModelProvidersRouteData } from "./route.ts";
import "./model-providers-page.ts";

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

export type AgentSelectElement = HTMLElement & {
  onSelect: (value: string) => void;
};

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
    config: {},
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
        return { config: {}, hash: "hash" };
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
    hello: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const gatewaySource = createApplicationGateway(snapshot);
  let selectionListener: (() => void) | undefined;
  const agentSelection = {
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
  let runtimeConfigListener: (() => void) | undefined;
  const subscribe = () => () => undefined;
  const runtimeConfig = {
    canPatch: true,
    state: {
      connected: true,
      configSnapshot: { config: {} },
      configForm: {
        agents: { defaults: { thinkingDefault: "low", fastModeDefault: "auto" } },
      },
      configLoading: false,
      configSaving: false,
      configApplying: false,
      configNeedsApply: false,
      configFormMode: "form",
      configFormDirty: false,
      configAutoSaveStatus: "idle",
      lastError: null as string | null,
    },
    ensureLoaded: vi.fn(async (): Promise<void> => undefined),
    patch: vi.fn(async () => true),
    beforeExternalDispatch: vi.fn(async (): Promise<void> => undefined),
    runExternalMutation: vi.fn(
      async <T>(
        task: (client: GatewayBrowserClient) => Promise<T>,
        options: RuntimeConfigExternalMutationOptions<T> = {},
      ): Promise<RuntimeConfigExternalMutationResult<T>> => {
        await runtimeConfig.beforeExternalDispatch();
        const client = snapshot.client;
        if (!client || (options.canDispatch && !options.canDispatch())) {
          return { ok: false, reason: "unavailable", error: "Scope changed before dispatch" };
        }
        const value = await task(client);
        await runtimeConfig.refresh();
        return {
          ok: true,
          value,
          refresh: runtimeConfig.state.lastError
            ? { ok: false, error: runtimeConfig.state.lastError }
            : { ok: true },
        };
      },
    ),
    patchForm: vi.fn(),
    removeFormValue: vi.fn(),
    refresh: vi.fn(async () => undefined),
    save: vi.fn(async () => true),
    apply: vi.fn(async () => true),
    discardDraft: vi.fn(async () => undefined),
    subscribe(listener: () => void) {
      runtimeConfigListener = listener;
      return () => {
        runtimeConfigListener = undefined;
      };
    },
  };
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
    agentSelection,
    runtimeConfig,
    overlays: {
      snapshot: { updateRunning: false, updateReconciliationPending: false },
      subscribe,
    },
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  return {
    agentSelection,
    context,
    deferNextAuthStatus,
    notifySelection: () => selectionListener?.(),
    notifyRuntimeConfig: () => runtimeConfigListener?.(),
    publishEvent: gatewaySource.publishEvent,
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
    agentId: context.agentSelection.state.selectedId,
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
