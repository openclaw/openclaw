import { setImmediate } from "node:timers/promises";
import { createRouter } from "@openclaw/uirouter";
import { createSignal } from "solid-js";
import { afterEach, expect, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type {
  ModelAuthStatusProvider,
  ModelAuthStatusResult,
  ModelCatalogResult,
} from "../../api/types.ts";
import type { RouteId } from "../../app-routes.ts";
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
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { updatePickers } from "../../test-helpers/select-picker.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { EMPTY_MODEL_PROVIDERS_DATA, type ModelProvidersData } from "./load.ts";
import { createModelProviders, type ModelProvidersOwner } from "./model-providers-controller.ts";
import { ModelProvidersContent } from "./model-providers-page.tsx";
import type { ModelProvidersRouteData } from "./route.ts";

type MountedPage = {
  mount: () => void;
  unmount: () => void;
};
const pages = new Map<ModelProvidersPageTestElement, MountedPage>();

const configOwners = new Set<RuntimeConfigCapability>();
afterEach(() => {
  for (const page of pages.values()) {
    page.unmount();
  }
  pages.clear();
  for (const owner of configOwners) {
    owner.dispose();
  }
  configOwners.clear();
});

export type ModelProvidersPageTestElement = Pick<
  HTMLElement,
  "querySelector" | "querySelectorAll" | "isConnected"
> & {
  readonly view: ReturnType<ModelProvidersOwner["viewProps"]>;
  context: ApplicationContext;
  renderRoot: HTMLElement;
  routeData: ModelProvidersRouteData | undefined;
  loaderPending: boolean;
  updateComplete: Promise<boolean>;
};

const modelPickerLabels = {
  primary: "Model",
  utility: "Utility Model",
  fallback: "Fallback Model",
  decision: "Decision Model",
};

export function modelPicker(
  page: Pick<ParentNode, "querySelector">,
  role: keyof typeof modelPickerLabels,
): SelectPicker {
  const picker = page.querySelector<SelectPicker>(
    `.model-providers__defaults openclaw-select-picker:has(.picker-select__trigger[aria-label^="${modelPickerLabels[role]}"])`,
  );
  expect(picker, `${role} model picker`).not.toBeNull();
  return picker!;
}

export function chatModelPickers(page: Pick<ParentNode, "querySelector">): SelectPicker[] {
  return (["primary", "utility", "fallback"] as const).map((role) => modelPicker(page, role));
}

export async function retryCatalog(page: ModelProvidersPageTestElement): Promise<void> {
  await page.updateComplete;
  const retry = page.querySelector<HTMLButtonElement>(".model-providers__catalog-progress button");
  expect(retry?.textContent?.trim()).toBe("Retry");
  retry!.click();
  await page.updateComplete;
}

export async function drainPageUpdates(page: ModelProvidersPageTestElement): Promise<void> {
  // Drain every promise continuation before checking that a retired result stayed absent.
  await setImmediate();
  await page.updateComplete;
  await updatePickers(page.renderRoot);
}

export function displayedCatalog(page: ModelProvidersPageTestElement) {
  return peekModelCatalog(
    page.context.gateway.snapshot.client!,
    { agentId: page.context.settingsAgentSelection.state.selectedId ?? "" },
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

export async function openModelPicker(
  page: ModelProvidersPageTestElement,
  role: keyof typeof modelPickerLabels = "primary",
): Promise<void> {
  await updatePickers(page.renderRoot);
  const picker = modelPicker(page, role);
  const trigger = picker.querySelector<HTMLButtonElement>(".picker-select__trigger");
  expect(trigger).not.toBeNull();
  if (trigger!.getAttribute("aria-expanded") === "true") {
    trigger!.click();
    await picker.updateComplete;
  }
  trigger!.click();
  await picker.updateComplete;
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
    updatedAt: 1,
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

/** Opens a connected provider row so its accounts, messages and actions render. */
export async function expandProvider(
  page: ModelProvidersPageTestElement,
  providerId: string,
): Promise<HTMLElement> {
  const selector = `li.provider-row[data-provider-id="${providerId}"]`;
  await waitForSolid(() =>
    expect(page.querySelector(selector), `${providerId} provider row`).not.toBeNull(),
  );
  const row = page.querySelector<HTMLElement>(selector);
  const summary = row!.querySelector<HTMLButtonElement>(":scope > button.provider-row__summary");
  expect(summary, `${providerId} provider summary`).not.toBeNull();
  if (summary!.getAttribute("aria-expanded") !== "true") {
    summary!.click();
    await page.updateComplete;
  }
  expect(summary!.getAttribute("aria-expanded")).toBe("true");
  return row!;
}

export async function saveKey(page: ModelProvidersPageTestElement, value: string) {
  publishRouteData(page, createApiKeyProviderData());
  page.view.props.onOpenKeyEditor("openai");
  page.view.props.onKeyDraftChange(value);
  await page.updateComplete;
  page.querySelector<HTMLButtonElement>(".model-providers__inline-form button")!.click();
}

export async function openApiKeyProvider(page: ModelProvidersPageTestElement, provider: string) {
  await page.view.scope.onConnect();
  await page.updateComplete;
  const choice = page.querySelector<HTMLButtonElement>(
    `[data-models-login-provider="${provider}"]`,
  );
  expect(choice).not.toBeNull();
  choice!.click();
  await page.updateComplete;
  page.querySelector<HTMLButtonElement>("[data-models-login-api-key]")!.click();
  await page.updateComplete;
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
  const selectionListeners = new Set<() => void>();
  const settingsAgentSelection = {
    intentRevision: 0,
    state: {
      selectedId: initialScopeId as string | null,
      scopeId: initialScopeId as string | null,
    },
    set: vi.fn(),
    setScope: vi.fn(),
    subscribe(listener: () => void) {
      selectionListeners.add(listener);
      return () => selectionListeners.delete(listener);
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
      async <T,>(
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
    router: createRouter<RouteId, ApplicationContext>({
      routes: [{ id: "chat", path: "/chat", component: () => ({}) }],
    }),
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
    notifySelection: () => selectionListeners.forEach((listener) => listener()),
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
  await waitForSolid(() => {
    expect(page.view.props.updatedAt).toEqual(expect.any(Number));
    expect(page.context.runtimeConfig.state.configLoading).toBe(false);
    if (expectedConfig) {
      expect(currentConfigObject(page.context.runtimeConfig.state)).toEqual(expectedConfig);
    }
  });
}

export async function advanceUsageRetries(): Promise<void> {
  for (const delay of [5_000, 10_000, 20_000]) {
    await vi.advanceTimersByTimeAsync(delay);
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

export function publishRouteData(page: ModelProvidersPageTestElement, data: ModelProvidersData) {
  const { gateway, settingsAgentSelection } = page.context;
  page.routeData = {
    ...page.routeData,
    gateway,
    gatewaySnapshot: gateway.snapshot,
    client: gateway.snapshot.client,
    agentId: settingsAgentSelection.state.selectedId,
    selectionIntentRevision: settingsAgentSelection.intentRevision,
    data,
  };
  flush();
}

export function createPage(context: ApplicationContext): ModelProvidersPageTestElement {
  const root = document.createElement("div");
  let owner!: ModelProvidersOwner;
  let routeData: ModelProvidersRouteData | undefined;
  let loaderPending = false;
  let publishInputs: (() => void) | undefined;
  let view: ReturnType<typeof mountSolid> | undefined;
  const page: ModelProvidersPageTestElement = {
    context,
    renderRoot: root,
    querySelector: root.querySelector.bind(root),
    querySelectorAll: root.querySelectorAll.bind(root),
    get isConnected() {
      return root.isConnected;
    },
    get view() {
      return owner.viewProps();
    },
    get routeData() {
      return routeData;
    },
    set routeData(value) {
      routeData = value;
      publishInputs?.();
    },
    get loaderPending() {
      return loaderPending;
    },
    set loaderPending(value) {
      loaderPending = value;
      publishInputs?.();
    },
    get updateComplete() {
      return Promise.resolve().then(() => {
        flush();
        return true;
      });
    },
  };
  pages.set(page, {
    mount: () => {
      if (view) {
        return;
      }
      document.body.append(root);
      view = mountSolid(
        () => {
          const [revision, setRevision] = createSignal(0);
          publishInputs = () => setRevision((value) => value + 1);
          owner = createModelProviders(page.context, {
            get routeData() {
              revision();
              return routeData;
            },
            get loaderPending() {
              revision();
              return loaderPending;
            },
          });
          return <ModelProvidersContent controller={owner} />;
        },
        { container: root },
      );
    },
    unmount: () => {
      view?.unmount();
      view = undefined;
      publishInputs = undefined;
      root.remove();
    },
  });
  return page;
}

export function mountPage(page: ModelProvidersPageTestElement): void {
  const mounted = pages.get(page);
  if (!mounted) {
    throw new Error("Page was not created by this harness");
  }
  mounted.mount();
}

export function unmountPage(page: ModelProvidersPageTestElement): void {
  pages.get(page)?.unmount();
}

export function appendPage(context: ApplicationContext) {
  const page = createPage(context);
  page.routeData = createEmptyModelProvidersRouteData(context);
  mountPage(page);
  return page;
}

export function clickLoginChoice(page: ModelProvidersPageTestElement, label: string) {
  const button = [
    ...page.querySelectorAll<HTMLButtonElement>("[data-models-login-choice] button"),
  ].find((candidate) => candidate.querySelector("strong")?.textContent === label);
  expect(button).toBeDefined();
  button!.click();
}

export async function startSelectedLogin(page: ModelProvidersPageTestElement, label: string) {
  clickLoginChoice(page, label);
  await waitForSolid(() =>
    expect(page.querySelector<HTMLInputElement>('input[name="wizard-text"]')?.disabled).toBe(false),
  );
}

export async function submitCredential(page: ModelProvidersPageTestElement) {
  const manual = page.querySelector<HTMLDetailsElement>(".wizard-step__manual-entry");
  if (manual && !manual.open) {
    manual.querySelector<HTMLElement>("summary")!.click();
    expect(manual.open).toBe(true);
  }
  const input = page.querySelector<HTMLInputElement>('input[name="wizard-text"]')!;
  input.value = "synthetic-test-credential";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
  page.querySelector<HTMLButtonElement>('.wizard-step__form button[type="submit"]')!.click();
  await waitForSolid(() => expect(input.disabled).toBe(true));
}
