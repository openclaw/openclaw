import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol";
import { type Mock, vi } from "vitest";
import type {
  GatewayBrowserClient,
  GatewayEventFrame,
  GatewayEventListener,
} from "../../api/gateway.ts";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";
import "./custodian-page.tsx";

type TestCustodianPage = HTMLElement & {
  onboarding: boolean;
  store: CustodianSessionStore;
  updateComplete: Promise<boolean>;
};

type ContextHarness = {
  context: ApplicationContext;
  setGatewaySnapshot: (patch: Partial<ApplicationGatewaySnapshot>) => void;
  setGatewayToken: (token: string) => void;
  setPathname: (pathname: string) => void;
  setChannelsConnected: (connected: boolean) => void;
  setChannelsSnapshot: (snapshot: ChannelsStatusSnapshot | null) => void;
  setChannelsError: (error: string | null) => void;
  emitGatewayEvent: (event: Pick<GatewayEventFrame, "event" | "payload">) => void;
};

export function createContext(
  request: Mock,
  methods: string[] = ["openclaw.chat"],
  options: {
    agentsList?: ApplicationContext["agents"]["state"]["agentsList"];
    channelsSnapshot?: ChannelsStatusSnapshot | null;
    gatewayCapabilities?: string[];
    healthRequest?: typeof request;
  } = {},
): ContextHarness {
  let healthSnapshot: unknown = { channels: {} };
  const client = {
    request: (method: string, ...args: unknown[]) =>
      method === "health"
        ? (options.healthRequest?.(method, ...args) ?? Promise.resolve(healthSnapshot))
        : method === "openclaw.chat.history" && !methods.includes(method)
          ? Promise.resolve({ turns: [] })
          : request(method, ...args),
  } as unknown as GatewayBrowserClient;
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: {
      type: "hello-ok" as const,
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: {
        methods,
        capabilities: options.gatewayCapabilities ?? [
          GATEWAY_SERVER_CAPS.SYSTEM_AGENT_WIZARD_CANCEL,
        ],
      },
    },
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const connection = {
    gatewayUrl: "ws://gateway.test/control",
    token: "",
    bootstrapToken: "",
    password: "",
  };
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection,
    subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEvents: (listener: GatewayEventListener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as unknown as ApplicationGateway;
  const agentListeners = new Set<() => void>();
  const channelListeners = new Set<(state: ApplicationContext["channels"]["state"]) => void>();
  const channelState: ApplicationContext["channels"]["state"] = {
    client,
    connected: true,
    channelsLoading: false,
    channelsLoadingProbe: null,
    channelsRefreshSeq: 0,
    channelsSnapshot: options.channelsSnapshot ?? null,
    channelsRead: null,
    channelsError: null,
    channelsLastSuccess: options.channelsSnapshot ? Date.now() : null,
    pairingLoading: false,
    pairingRefreshSeq: 0,
    pairingSnapshot: null,
    pairingRead: null,
    pairingError: null,
    pairingLastSuccess: null,
    pairingBusyRequestId: null,
    whatsappLoginMessage: null,
    whatsappLoginQrDataUrl: null,
    whatsappLoginSessionKey: null,
    whatsappLoginConnected: null,
    whatsappBusy: false,
  };
  let settleChannels: ((error: string | null) => void) | undefined;
  const refreshChannels = vi.fn(() => {
    settleChannels?.(null);
    const { promise, resolve } = Promise.withResolvers<string | null>();
    settleChannels = resolve;
    channelState.channelsRead = { completion: promise };
    channelState.channelsLoading = true;
    for (const listener of channelListeners) {
      listener(channelState);
    }
    return promise.then(() => undefined);
  });
  const routeListeners = new Set<() => void>();
  const context = {
    gateway,
    runtimeConfig: {
      state: { configSnapshot: null, configLoading: false, lastError: null },
      ensureLoaded: vi.fn(async () => undefined),
      subscribe: () => () => undefined,
    },
    router: {
      getState: () => ({ location: { pathname: window.location.pathname } }),
      subscribe: (listener: () => void) => {
        routeListeners.add(listener);
        return () => routeListeners.delete(listener);
      },
    },
    agents: {
      state: {
        agentsList: options.agentsList ?? {
          defaultId: "main",
          mainKey: "main",
          scope: "global",
          agents: [{ id: "main", model: { primary: "openai/gpt-5.5" } }],
        },
      },
      subscribe: (listener: () => void) => {
        agentListeners.add(listener);
        return () => agentListeners.delete(listener);
      },
      refreshList: vi.fn(),
    },
    agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
    channels: {
      state: channelState,
      refresh: refreshChannels,
      subscribe: (listener: (state: ApplicationContext["channels"]["state"]) => void) => {
        channelListeners.add(listener);
        return () => channelListeners.delete(listener);
      },
    },
    basePath: "",
    navigate: vi.fn(),
    replace: vi.fn(),
  } as unknown as ApplicationContext;
  return {
    context,
    setPathname: (pathname) => {
      window.history.replaceState({}, "", pathname);
      for (const listener of routeListeners) {
        listener();
      }
    },
    setGatewaySnapshot: (patch) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    setGatewayToken: (value) => {
      const credentials = { token: value };
      connection.token = credentials.token;
    },
    setChannelsConnected: (connected) => {
      settleChannels?.(null);
      channelState.channelsRead = null;
      channelState.connected = connected;
      channelState.channelsLoading = false;
      channelState.channelsError = null;
      for (const listener of channelListeners) {
        listener(channelState);
      }
    },
    setChannelsSnapshot: (nextSnapshot) => {
      channelState.channelsSnapshot = nextSnapshot;
      channelState.channelsLastSuccess = nextSnapshot ? Date.now() : null;
      channelState.channelsLoading = false;
      channelState.channelsError = null;
      settleChannels?.(null);
      for (const listener of channelListeners) {
        listener(channelState);
      }
    },
    setChannelsError: (error: string | null) => {
      channelState.channelsLoading = false;
      channelState.channelsError = error;
      settleChannels?.(error);
      for (const listener of channelListeners) {
        listener(channelState);
      }
    },
    emitGatewayEvent: (event) => {
      if (event.event === "health") {
        healthSnapshot = event.payload;
      }
      for (const listener of eventListeners) {
        listener(event as GatewayEventFrame);
      }
    },
  };
}

export async function mountPage(
  context: ApplicationContext,
  options: { onboarding?: boolean } = {},
): Promise<{
  page: TestCustodianPage;
  provider: ApplicationContextProvider;
}> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-custodian-page") as TestCustodianPage;
  page.store = new CustodianSessionStore();
  page.onboarding = options.onboarding ?? true;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return { page, provider };
}
