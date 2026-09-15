import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsFilesListResult,
  AgentsListResult,
  ModelCatalogEntry,
  ToolsEffectiveResult,
} from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createGatewayMetadataObserver } from "../../app/gateway-observers.ts";
import type { PanelRefreshStatus } from "../../components/panel-refresh-status.ts";
import type { AgentsPanel } from "../../lib/agents/panels.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import type { CronState } from "../../lib/cron/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { AgentsRouteData } from "./route.ts";

const AGENTS_PAGE_GATEWAY_HELLO = gatewayHelloForMethods([
  "config.patch",
  "config.set",
  "agents.update",
]);

export type TestAgentsPage = HTMLElement & {
  context: ApplicationContext;
  readonly client: GatewayBrowserClient | null;
  readonly connected: boolean;
  agentsList: unknown;
  agentsSelectedId: string | null;
  routeData?: AgentsRouteData;
  agentFilesLoading: boolean;
  agentFilesList: AgentsFilesListResult | null;
  agentFileActive: string | null;
  agentFileContents: Record<string, string>;
  agentIdentityLoading: boolean;
  agentSkillsError: string | null;
  readonly agentsPanel: AgentsPanel;
  readonly sessions: ApplicationContext["sessions"];
  toolsEffectiveError: string | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveResult: ToolsEffectiveResult | null;
  chatModelCatalog: ModelCatalogEntry[];
  chatModelCatalogStatus: PanelRefreshStatus;
  cron: CronState;
  requestGeneration: number;
  routeDataInitialized: boolean;
  subscriptions: {
    hostConnected: () => void;
    hostUpdate: () => void;
    hostDisconnected: () => void;
  };
  willUpdate: (changed: Map<PropertyKey, unknown>) => void;
  gateway: {
    readonly snapshot: ApplicationGatewaySnapshot | null;
    applySnapshot: (
      snapshot: ApplicationGatewaySnapshot,
      binding: { initial: boolean; sourceChanged: boolean },
    ) => void;
    invalidate: () => void;
  };
  ensureAgentIdentities: () => void;
  loadActivePanelData: () => void;
  ensureModelCatalog: (options?: { refresh?: boolean }) => void;
  refreshCron: () => Promise<void>;
  requestUpdate: () => void;
  runCronTask: <T>(task: (cronState: CronState) => Promise<T>) => Promise<T>;
  loadEffectiveToolsForAgent: (agentId: string) => void;
  loadAgentFiles: (agentId: string, force?: boolean) => Promise<void>;
  clearAgentSkills: (agentId: string) => void;
  saveAgentConfig: () => void;
  identityDraft: { name: string | null; emoji: string | null; avatar: string | null };
  saveIdentityDraft: () => void;
  setDefaultAgent: (agentId: string) => void;
};

export function setPageGateway(
  page: TestAgentsPage,
  client: GatewayBrowserClient | null,
  connected = true,
  sourceChanged = false,
) {
  const next = snapshot(client, connected);
  const previous = page.gateway.snapshot;
  if (previous) {
    // Application connection retirement precedes page-local request invalidation.
    createGatewayMetadataObserver((current) => current === next).synchronize(previous, next);
  }
  if (!page.context?.gateway || sourceChanged) {
    page.context = { ...page.context, gateway: gateway(next) };
  }
  page.gateway.applySnapshot(next, { initial: false, sourceChanged });
}

export function snapshot(
  client: GatewayBrowserClient | null,
  connected = true,
): ApplicationGatewaySnapshot {
  return {
    client,
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: AGENTS_PAGE_GATEWAY_HELLO,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
}

const eventListeners = new WeakMap<
  ApplicationContext["gateway"],
  Set<Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0]>
>();

export function emitCatalogChanged(currentGateway: ApplicationContext["gateway"]) {
  const client = currentGateway.snapshot.client;
  if (client) {
    invalidateChatMetadataStore(client);
  }
  for (const listener of eventListeners.get(currentGateway) ?? []) {
    listener({ type: "event", event: "chat.metadata.changed", payload: {} });
  }
}

export function gateway(current: ApplicationGatewaySnapshot): ApplicationContext["gateway"] {
  const listeners = new Set<Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0]>();
  const result = {
    subscribeEvents: (
      listener: Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0],
    ) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: current,
    subscribe: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["gateway"];
  eventListeners.set(result, listeners);
  return result;
}

export function settingsSelection(
  agentsList: AgentsListResult | null,
  selectedId: string | null = "main",
) {
  const selection = createAgentSelectionCapability(
    {
      connection: { gatewayUrl: "ws://settings.test" },
      snapshot: { assistantAgentId: "main" },
      subscribe: () => () => undefined,
    },
    { state: { agentsList }, subscribe: () => () => undefined },
    undefined,
    undefined,
    { requireConfiguredAgent: true },
  );
  selection.set(selectedId);
  return selection;
}

export const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [{ id: "main", name: "Main" }],
};

export function agentsRouteData(
  currentGateway: ApplicationContext["gateway"],
  roster: AgentsListResult | null = agentsList,
  requestedAgentId: string | null = "main",
  selection = settingsSelection(roster),
): AgentsRouteData {
  const pathname = requestedAgentId ? `/settings/agents/${requestedAgentId}` : "/settings/agents";
  return {
    gateway: currentGateway,
    gatewaySnapshot: currentGateway.snapshot,
    location: { pathname, search: "", hash: "" },
    requestedAgentId,
    settingsAgentSelection: selection,
    selectionIntentRevision: selection.intentRevision,
    panel: "files",
    agentsList: roster,
    error: null,
  };
}

export function agentsCapability(ensureFiles: () => Promise<AgentsFilesListResult>) {
  return {
    state: {
      client: null,
      connected: true,
      agentsLoading: false,
      agentsError: null,
      agentsList,
    },
    files: () => ({ list: null, loading: false, error: null }),
    ensureList: vi.fn(async () => agentsList),
    refreshList: vi.fn(async () => agentsList),
    ensureFiles,
    refreshFiles: ensureFiles,
    subscribe: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["agents"];
}

export function pageContext(
  currentGateway: ApplicationContext["gateway"],
  agents: ApplicationContext["agents"],
  options?: {
    agentIdentity?: ApplicationContext["agentIdentity"];
    sessions?: ApplicationContext["sessions"];
  },
): ApplicationContext {
  const subscribe = vi.fn(() => () => undefined);
  return {
    gateway: currentGateway,
    agents,
    settingsAgentSelection: settingsSelection(agents.state.agentsList),
    router: { getState: () => ({ matches: [{ routeId: "agents" }], pendingMatches: [] }) },
    navigate: vi.fn(),
    replace: vi.fn(),
    agentIdentity:
      options?.agentIdentity ??
      ({
        get: () => ({ agentId: "main" }),
        entries: () => [],
        ensure: vi.fn(async () => undefined),
        subscribe,
      } as unknown as ApplicationContext["agentIdentity"]),
    sessions:
      options?.sessions ??
      ({
        state: { result: null, modelOverrides: {} },
        subscribe,
      } as unknown as ApplicationContext["sessions"]),
    channels: { subscribe },
    runtimeConfig: { subscribe },
  } as unknown as ApplicationContext;
}
