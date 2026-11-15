import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { createRouter } from "@openclaw/uirouter";
import { createSignal } from "solid-js";
import { expect, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { mountRouterOutlet } from "../../app/router-outlet.test-support.tsx";
import type { SelectPicker } from "../../components/select-picker.ts";
import { t } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { completeConfigContext } from "./config-page.test-support.ts";
import type { ConfigPageId, ConfigPageRouteData } from "./config-page.tsx";
import { pages } from "./route.ts";
import { TalkSettingsPage } from "./talk-page.tsx";

export type TalkPageElement = HTMLElement & {
  context: ApplicationContext;
  configObject: Record<string, unknown>;
  changeModel: (model: string | null) => void;
  changeProvider: (providerId: string | null) => void;
};

export function nativeVoice(snapshot: NonNullable<NativeDeviceSettingsCapability["snapshot"]>) {
  const listeners = new Set<() => void>();
  const settings = {
    snapshot,
    initialSnapshot: Promise.resolve(snapshot),
    set: vi.fn<NativeDeviceSettingsCapability["set"]>(),
    subscribe: (listener: Parameters<NativeDeviceSettingsCapability["subscribe"]>[0]) => {
      const notify = () => listener(snapshot);
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    requestPermission: vi.fn(),
    openSystemSettings: vi.fn(),
    openPanel: vi.fn(),
    checkForUpdates: vi.fn(),
    setupChromeExtension: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
  } satisfies NativeDeviceSettingsCapability;
  return {
    settings,
    publish: () => {
      listeners.forEach((notify) => notify());
      flush();
    },
  };
}

/** The realtime model picker; the speech-to-text section renders its own picker. */
export function realtimeModelPicker(page: HTMLElement): SelectPicker | null {
  return (
    [...page.querySelectorAll<SelectPicker>("openclaw-select-picker")].find(
      (picker) => picker.params.label === t("talkPage.model.title"),
    ) ?? null
  );
}

export function readVoiceOptions(page: HTMLElement): string[] {
  return [...page.querySelectorAll("select option")].map(
    (option) => option.getAttribute("value") ?? "",
  );
}

export function setTalkRealtimeConfig(page: TalkPageElement, realtime: Record<string, unknown>) {
  page.configObject = { talk: { realtime } };
}

export function expectVoiceState(page: TalkPageElement, options: string[], unsupported: boolean) {
  expect(readVoiceOptions(page)).toEqual(options);
  expect(page.textContent?.includes(t("talkPage.voice.unsupportedDefault"))).toBe(unsupported);
}

export function mountTalkPage(context: ApplicationContext, initialConfig: Record<string, unknown>) {
  const page: TalkPageElement = Object.assign(document.createElement("div"), {
    context,
    configObject: initialConfig,
    changeModel: (value: string | null) => {
      flush();
      const picker = realtimeModelPicker(page);
      if (!picker) {
        throw new Error("Talk model picker is unavailable");
      }
      picker.params.onChange(value ?? "");
    },
    changeProvider: (value: string | null) => {
      const input = [...page.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
        (entry) => entry.value === (value ?? ""),
      );
      if (!input) {
        throw new Error("Talk provider choice is unavailable");
      }
      input.click();
    },
  });
  const [config, setConfig] = createSignal(initialConfig);
  document.body.append(page);
  const provider = createSolidApplicationContextProvider(context);
  const retired = new Promise<void>(() => {});
  const view = mountSolid(
    () => <TalkSettingsPage configObject={config()} presentationRetired={() => retired} />,
    { container: page, wrapper: provider.wrapper },
  );
  const remove = page.remove.bind(page);
  Object.defineProperties(page, {
    context: { value: context },
    configObject: { get: config, set: setConfig },
  });
  page.remove = () => {
    view.unmount();
    remove();
  };
  flush();
  return page;
}

export async function mountTalkSettingsRoutes(initialContext: ApplicationContext) {
  const context = completeConfigContext(initialContext);
  type SettingsRoute = Extract<(typeof pages)[number], { id: ConfigPageId }>;
  const routes = pages.filter(
    (route): route is SettingsRoute => route.id === "talk" || route.id === "notifications",
  );
  const productionModule = await routes[0]!.component();
  const Provider = createSolidApplicationContextProvider(context).wrapper;
  const ProductionRender = productionModule.renderSolid;
  const module = {
    ...productionModule,
    renderSolid: (props: SolidRouteProps<ConfigPageRouteData>) => (
      <Provider>
        <ProductionRender {...props} />
      </Provider>
    ),
  };
  const router = createRouter<ConfigPageId, ApplicationContext, typeof module, ConfigPageRouteData>(
    { routes: routes.map((route) => Object.assign({}, route, { component: () => module })) },
  );
  Object.assign(context, { router });
  const outlet = mountRouterOutlet({ router, retryContext: context });
  onTestFinished(async () => {
    outlet.dispose();
    router.stop();
    // The production route starts independent lazy siblings; finish their imports before teardown.
    await vi.dynamicImportSettled();
  });
  await router.navigate("talk", context);
  return {
    container: outlet,
    navigate: (pageId: "talk" | "notifications") => router.navigate(pageId, context),
  };
}

/** Mounted Talk page with a scripted Gateway client and a stubbed runtime config. */
export type TalkMutationHarnessOptions = {
  configSaving?: boolean;
  speakerVoice?: string | null;
  providerOption?: Partial<TalkCatalogResult["realtime"]["providers"][number]>;
  nativeDeviceSettings?: NativeDeviceSettingsCapability;
  voiceWakeRequest?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<{ triggers: string[] }>;
  catalogRequest?: (
    requestIndex: number,
    catalog: TalkCatalogResult,
  ) => Promise<TalkCatalogResult> | TalkCatalogResult;
  configSnapshot?: { hash?: string | null; configRevisionHash?: string | null };
  activeProvider?: string | null;
  activeVoiceSelectionPolicy?: "allowlist-default";
  aliases?: string[];
  consultRouting?: string | null;
  defaultModel?: string;
  model?: string | null;
  openAIProviderModel?: string;
  provider?: string | null;
  transport?: string | null;
  transports?: TalkCatalogResult["transports"];
  voicesByModel?: Record<string, string[]>;
  navigate?: ReturnType<typeof vi.fn>;
};

export function createTalkMutationHarness(options: TalkMutationHarnessOptions = {}) {
  const catalog = {
    modes: ["realtime"],
    transports: ["gateway-relay", "webrtc"],
    brains: ["agent-consult"],
    speech: { providers: [] },
    transcription: { providers: [] },
    realtime: {
      ready: true,
      activeProvider: options.activeProvider ?? "openai",
      providers: [
        {
          id: "openai",
          label: "OpenAI",
          configured: true,
          aliases: options.aliases ?? [],
          models: [options.defaultModel ?? "gpt-live-test-canary"],
          voices: ["marin"],
          activeVoices: ["cove", "spruce"],
          activeVoiceSelectionPolicy: options.activeVoiceSelectionPolicy,
          voicesByModel: options.voicesByModel,
          modelFamilySettings: {
            family: "gpt-live",
            unlistedModelVoices: "active",
            unsupportedTransports: ["provider-websocket"],
            gatewayRelayHandlesAgentConsult: true,
            hint: {
              titleKey: "talkPage.gptLive.title",
              descriptionKey: "talkPage.gptLive.hint",
              readyKey: "talkPage.gptLive.ready",
            },
          },
          transports: options.transports ?? ["gateway-relay"],
          defaultModel: options.defaultModel ?? "gpt-live-test-canary",
          ...options.providerOption,
        },
        {
          id: "xai",
          label: "xAI",
          configured: true,
          aliases: [],
          models: ["grok-voice"],
          voices: ["ara"],
          activeVoices: ["xai-active"],
          transports: ["gateway-relay"],
          defaultModel: "grok-voice",
        },
      ],
    },
  } satisfies TalkCatalogResult;
  let catalogRequestIndex = 0;
  const request = vi.fn(async (_method: string, _params: Record<string, unknown>) => {
    catalogRequestIndex += 1;
    return await (options.catalogRequest?.(catalogRequestIndex, catalog) ?? catalog);
  });
  const { gateway, publish } = createApplicationGateway();
  gateway.connection.gatewayUrl = "wss://gateway.example.test";
  const hello: ApplicationContext["gateway"]["snapshot"]["hello"] = options.voiceWakeRequest
    ? {
        type: "hello-ok" as const,
        protocol: 4,
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["voicewake.get", "voicewake.set"] },
      }
    : null;
  publish({
    ...gateway.snapshot,
    client: {
      request: (method: string, params: Record<string, unknown>) =>
        method.startsWith("voicewake.")
          ? (options.voiceWakeRequest?.(method, params) ?? Promise.resolve({ triggers: [] }))
          : request(method, params),
    } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello,
    assistantAgentId: "main",
    sessionKey: "main",
  });
  const configForm = {
    talk: {
      realtime: {
        provider: options.provider === undefined ? "openai" : options.provider,
        ...(options.model === null
          ? {}
          : { model: options.model === undefined ? "gpt-realtime-2.1" : options.model }),
        transport: options.transport === undefined ? "gateway-relay" : options.transport,
        consultRouting: options.consultRouting,
        speakerVoice: options.speakerVoice,
        providers: options.openAIProviderModel
          ? { openai: { model: options.openAIProviderModel } }
          : undefined,
      },
    },
  };
  const runtimeConfigListeners = new Set<() => void>();
  const runtimeConfig = {
    state: {
      configForm,
      configSnapshot: options.configSnapshot ?? { hash: "hash" },
      configLoading: false,
      configSaving: options.configSaving ?? false,
      configApplying: false,
    },
    patchForm: vi.fn(),
    removeFormValue: vi.fn(),
    subscribe: (listener: () => void) => {
      runtimeConfigListeners.add(listener);
      return () => runtimeConfigListeners.delete(listener);
    },
  };
  const context = {
    nativeDeviceSettings: options.nativeDeviceSettings ?? null,
    gateway,
    runtimeConfig,
    ...(options.navigate
      ? { navigate: options.navigate, settingsAgentSelection: { set: vi.fn() } }
      : {}),
  } as unknown as ApplicationContext;
  const page = mountTalkPage(context, configForm);
  return {
    page,
    request,
    runtimeConfig,
    setConfigHash: (hash: string | null) => {
      runtimeConfig.state.configSnapshot.hash = hash;
      runtimeConfigListeners.forEach((notify) => notify());
    },
    setGatewayConnection: (connected: boolean, gatewayUrl = gateway.connection.gatewayUrl) => {
      gateway.connection.gatewayUrl = gatewayUrl;
      publish({
        ...gateway.snapshot,
        phase: connected ? "connected" : "reconnecting",
        hello: connected ? hello : null,
      });
    },
  };
}
