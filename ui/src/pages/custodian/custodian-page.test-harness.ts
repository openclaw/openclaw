import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol";
import { type Mock, vi } from "vitest";
import type {
  GatewayBrowserClient,
  GatewayEventFrame,
  GatewayEventListener,
} from "../../api/gateway.ts";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
import { createChannelsState } from "../channels/view.test-support.ts";
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

type OverlayListener = Parameters<ApplicationContext["overlays"]["subscribe"]>[0];

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
  const snapshot = createApplicationGatewaySnapshot({
    client,
    phase: "connected",
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
  });
  const eventListeners = new Set<GatewayEventListener>();
  const connection = {
    gatewayUrl: "ws://gateway.test/control",
    token: "",
    bootstrapToken: "",
    password: "",
  };
  const { gateway, publish } = createApplicationGateway(snapshot);
  Object.assign(gateway, {
    connection,
    subscribeEvents: (listener: GatewayEventListener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  });
  const agentListeners = new Set<() => void>();
  const channelListeners = new Set<(state: ApplicationContext["channels"]["state"]) => void>();
  const channelState = createChannelsState(options.channelsSnapshot ?? null, null, {
    client,
    channelsLastSuccess: options.channelsSnapshot ? Date.now() : null,
  });
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
  const overlayListeners = new Set<OverlayListener>();
  // The real overlay owner bootstraps against the Gateway. These tests account for
  // Custodian RPCs, so provide only the per-context observation surface used by the
  // real Inbox; its existing unsubscribe retires the listener with the mount.
  const overlays = {
    snapshot: {
      updateAvailable: null,
      updateSchedule: null,
      heldUpdateCampaignId: null,
      updateRunning: false,
      updateStatusRefreshing: false,
      updateCampaignStatusHydrated: true,
      updateReconciliationPending: false,
      updateStatusBanner: null,
      updateStatusCheckBanner: null,
      recordedUpdateAttempt: null,
      diagnosableUpdateFailureId: null,
      reportableUpdateFailureId: null,
      updateFailureReportBusy: false,
      updateFailureReportNotice: null,
      updateRun: null,
      updateRunAcknowledged: false,
      controlUiRefreshRequired: false,
      approvalQueue: [],
      approvalBusy: false,
      approvalCanGrant: false,
      approvalErrors: new Map(),
      devicePairSetupOpen: false,
      devicePairSetupLifecycle: { phase: "selection", access: "full" },
      devicePairPendingCount: 0,
    },
    subscribe: (listener: OverlayListener) => {
      overlayListeners.add(listener);
      return () => overlayListeners.delete(listener);
    },
  } satisfies Pick<ApplicationContext["overlays"], "snapshot" | "subscribe">;
  const context = {
    gateway,
    runtimeConfig: {
      state: { configSnapshot: null, configLoading: false, lastError: null },
      ensureLoaded: vi.fn(async () => undefined),
      ensureDisplayLoaded: vi.fn(async () => undefined),
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
    overlays,
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
      publish({ ...gateway.snapshot, ...patch });
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
