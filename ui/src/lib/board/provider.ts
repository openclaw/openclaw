import type { BoardCommandEvent, BoardGetParams, BoardSnapshot } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  normalizeDefaultMainSessionAliasForUi,
  resolveUiConversationIdentity,
} from "../sessions/session-key.ts";
import { GatewayBoardProvider } from "./gateway-provider.ts";
import { emptyBoardSnapshot } from "./provider-helpers.ts";
import { EventStream, ValueSignal } from "./provider-signals.ts";
import type { BoardProvider } from "./provider-types.ts";
import type { BoardWidgetAppViewState } from "./view-types.ts";
export type { BoardCommandEvent };
export type { BoardProvider } from "./provider-types.ts";
export type { BoardViewCallbacks, BoardWidgetAppViewState } from "./view-types.ts";
export { canvasWidgetNameForDocument, mcpAppWidgetNameForViewId } from "./widget-names.ts";

type BoardGatewayClient = Pick<GatewayBrowserClient, "request" | "addEventListener">;

export function boardExists(snapshot: BoardSnapshot): boolean {
  return snapshot.tabs.length > 0 || snapshot.widgets.length > 0;
}

export function createNullBoardProvider(key: string): BoardProvider {
  const sessionKey = normalizeDefaultMainSessionAliasForUi(key);
  const pinWidget = async () => {
    throw new Error("Session dashboard unavailable");
  };
  const widgetAppView = async (): Promise<BoardWidgetAppViewState> => ({
    status: "stale",
  });
  return {
    sessionKey,
    appViewGeneration: 0,
    canMutate: false,
    canGrant: false,
    canPinWidgets: false,
    canPinMcpApps: false,
    hasLoadedSnapshot: true,
    loadError$: new ValueSignal<string | null>(null),
    snapshot$: new ValueSignal(emptyBoardSnapshot(sessionKey)),
    events: new EventStream<BoardCommandEvent>(),
    async applyOps() {},
    async grant() {},
    pinWidget,
    pinMcpApp: pinWidget,
    widgetFrameUrl: () => "",
    async refreshWidgetFrame() {},
    widgetAppView,
    refreshWidgetAppView: widgetAppView,
  };
}

const gatewayProviders = new Map<
  string,
  { provider: GatewayBoardProvider; consumers: number; presentationScope?: object }
>();
export function boardProviderCacheKey(session: BoardGetParams): string {
  const identity = resolveUiConversationIdentity(
    {},
    normalizeDefaultMainSessionAliasForUi(session.sessionKey),
    session.agentId,
  );
  return JSON.stringify([session.agentId ?? identity.agentId, identity.sessionKey]);
}

// Session lookups are read-only: only a lifecycle-owned lease may create and
// subscribe a gateway transport, so hidden panes cannot orphan subscriptions.
export function boardProviderForSession(
  session: BoardGetParams,
  available = true,
): BoardProvider | undefined {
  return available ? gatewayProviders.get(boardProviderCacheKey(session))?.provider : undefined;
}

export type BoardProviderLease = {
  provider: BoardProvider;
  restoreSnapshot: (snapshot: unknown, receivedAtMs: number) => void;
  update: (
    client: BoardGatewayClient,
    connected: boolean,
    capabilities: Pick<BoardProvider, "canPinWidgets" | "canPinMcpApps" | "canMutate" | "canGrant">,
  ) => void;
  release: () => void;
};

export function acquireBoardProviderForSession(
  session: BoardGetParams,
  client: BoardGatewayClient,
  connected = true,
  canPinWidgets = true,
  canPinMcpApps = false,
  canMutate = true,
  canGrant = true,
  presentationScope?: object,
  cacheSnapshot?: (snapshot: BoardSnapshot | null, receivedAtMs: number) => void,
): BoardProviderLease {
  const key = boardProviderCacheKey(session);
  let entry = gatewayProviders.get(key);
  if (entry && entry.presentationScope !== presentationScope) {
    // Retiring views may still hold leases; they must not lend their account's
    // loaded transport to the new presentation owner.
    entry.provider.dispose();
    entry = undefined;
  }
  if (!entry) {
    const target = {
      ...session,
      sessionKey: normalizeDefaultMainSessionAliasForUi(session.sessionKey),
    };
    entry = {
      provider: new GatewayBoardProvider(target, client, connected),
      consumers: 0,
      presentationScope,
    };
    gatewayProviders.set(key, entry);
  } else {
    entry.provider.attachClient(client, connected);
  }
  const transport = entry.provider;
  let capabilities = {
    canPinWidgets,
    canPinMcpApps,
    canMutate,
    canGrant,
  };
  entry.consumers += 1;
  let released = false;
  let leaseConnected = connected;
  const isCurrent = () => !released && gatewayProviders.get(key) === entry;
  const requireCapability = (allowed: boolean, action: string) => {
    if (!allowed) {
      throw new Error(`Session dashboard ${action} unavailable`);
    }
  };
  const stopCache = cacheSnapshot ? transport.subscribeCacheSnapshot(cacheSnapshot) : undefined;
  return {
    restoreSnapshot: (snapshot, receivedAtMs) => {
      if (isCurrent()) {
        transport.restoreSnapshot(snapshot, receivedAtMs);
      }
    },
    // Transport snapshots are shared; mutation authority belongs to this live lease.
    provider: {
      loadError$: transport.loadError$,
      snapshot$: transport.snapshot$,
      events: transport.events,
      widgetFrameUrl: transport.widgetFrameUrl.bind(transport),
      refreshWidgetFrame: transport.refreshWidgetFrame.bind(transport),
      widgetAppView: transport.widgetAppView.bind(transport),
      refreshWidgetAppView: transport.refreshWidgetAppView.bind(transport),
      get sessionKey() {
        return transport.sessionKey;
      },
      get appViewGeneration() {
        return transport.appViewGeneration;
      },
      get hasLoadedSnapshot() {
        return transport.hasLoadedSnapshot;
      },
      get canPinWidgets() {
        return isCurrent() && leaseConnected && capabilities.canPinWidgets;
      },
      get canPinMcpApps() {
        return isCurrent() && leaseConnected && capabilities.canPinMcpApps;
      },
      get canMutate() {
        return isCurrent() && leaseConnected && capabilities.canMutate;
      },
      get canGrant() {
        return isCurrent() && leaseConnected && capabilities.canGrant;
      },
      async applyOps(ops) {
        requireCapability(this.canMutate, "mutation");
        await transport.applyOps(ops);
      },
      async grant(name, decision) {
        requireCapability(this.canGrant, "approval");
        await transport.grant(name, decision);
      },
      async pinWidget(input) {
        requireCapability(this.canMutate && this.canPinWidgets, "widget pinning");
        await transport.pinWidget(input);
      },
      async pinMcpApp(input) {
        requireCapability(this.canMutate && this.canPinMcpApps, "MCP App pinning");
        await transport.pinMcpApp(input);
      },
    },
    update: (nextClient, nextConnected, nextCapabilities) => {
      if (!isCurrent()) {
        return;
      }
      capabilities = nextCapabilities;
      leaseConnected = nextConnected;
      entry.provider.attachClient(nextClient, nextConnected);
    },
    release: () => {
      if (released) {
        return;
      }
      released = true;
      stopCache?.();
      entry.consumers -= 1;
      if (entry.consumers > 0) {
        return;
      }
      if (gatewayProviders.get(key) === entry) {
        gatewayProviders.delete(key);
      }
      entry.provider.dispose();
    },
  };
}
