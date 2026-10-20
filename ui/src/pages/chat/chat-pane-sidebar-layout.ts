import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { createChangeListeners } from "../../../../src/shared/listeners.js";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { ensureCustomElementDefined } from "../../app/lazy-custom-element.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import type { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { uiConversationMatches } from "../../lib/sessions/session-key.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import type { SidebarRegionParams } from "./chat-pane-sidebar-view.tsx";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import type { SidebarFullMessageLoader } from "./components/chat-sidebar-content-types.ts";
import type { SidebarRegionCallbacks } from "./components/chat-sidebar-region-types.ts";
import {
  activatePanel,
  toggleSidebarPanelExpanded,
  closeSlot,
  fitSidebarLayout,
  openSlot,
  reorderPanel,
  isSidebarSlotVisible,
  type SidebarLayout,
  type SidebarSlotId,
} from "./sidebar-layout.ts";

const DETAIL_FULL_MESSAGE_MAX_CHARS = 500_000;
type LazyPanelRuntime = {
  error?: Parameters<typeof LazyViewError>[0];
  pending?: Promise<void>;
};

type LazyElementKey = "region" | "detail-panel" | SidebarSlotId;
type LazyElement = readonly [tagName: string, loadModule: () => Promise<unknown>];

const LAZY_SIDEBAR_ELEMENTS: Partial<Record<LazyElementKey, LazyElement>> = {
  dashboard: ["openclaw-board-view", () => import("../../components/board/board-view.ts")],
  region: [
    "openclaw-chat-sidebar-region",
    () => import("./components/chat-sidebar-region.runtime.tsx"),
  ],
  // Not a slot key: the detail slot also renders tool output and status
  // templates synchronously, so only its panel branch waits for this element.
  "detail-panel": [
    "openclaw-chat-detail-panel",
    () => import("./components/chat-detail-panel.tsx"),
  ],
  terminal: [
    "openclaw-terminal-panel",
    () => import("../../components/terminal/terminal-panel-registration.ts"),
  ],
  "link-reader": [
    "openclaw-link-reader-panel",
    () => import("../../components/link-reader-panel.tsx"),
  ],
  browser: ["openclaw-browser-panel", () => import("../../components/browser/browser-panel.ts")],
  desktop: ["openclaw-desktop-panel", () => import("../../components/desktop/desktop-panel.ts")],
  portal: ["openclaw-portals-page", () => import("../portals/portals-page.tsx")],
  companion: ["openclaw-chat-session-rail", () => import("./components/chat-session-rail.tsx")],
  processes: [
    "openclaw-chat-processes-panel",
    () => import("./components/chat-processes-panel.tsx"),
  ],
  subagents: [
    "openclaw-chat-subagents-panel",
    () => import("./components/chat-subagents-panel.tsx"),
  ],
  discussion: [
    "openclaw-session-discussion",
    () => import("./components/session-discussion-panel.tsx"),
  ],
};

const lazyRuntimes = new Map<LazyElementKey, LazyPanelRuntime>();
const lazyListeners = createChangeListeners();

export const lazySidebarElements = {
  get snapshot(): ReadonlyMap<LazyElementKey, LazyPanelRuntime> {
    return lazyRuntimes;
  },
  subscribe: lazyListeners.subscribe,
};

export function ensureLazySidebarElement(key: LazyElementKey) {
  const element = LAZY_SIDEBAR_ELEMENTS[key];
  if (!element) {
    return undefined;
  }
  const [tagName, loadModule] = element;
  if (customElements.get(tagName)) {
    lazyRuntimes.delete(key);
    return undefined;
  }
  const runtime = lazyRuntimes.get(key) ?? {};
  lazyRuntimes.set(key, runtime);
  if (runtime.error !== undefined) {
    return runtime.error;
  }
  if (runtime.pending) {
    return null;
  }
  runtime.pending = ensureCustomElementDefined(tagName, loadModule)
    .catch((error: unknown) => {
      runtime.error = {
        error,
        stale: isStaleChunkImportError(error),
        onRetry: () => void retryStaleChunkReloadWhenReachable(),
      };
    })
    .finally(() => {
      delete runtime.pending;
      lazyListeners.publish();
    });
  return null;
}

/**
 * Region callbacks: the pure layout moves resolve here, while the pane injects
 * what only it owns — the board dock, the cached discussion url, the persisted
 * resize, and the panel's open state.
 */
export function sidebarRegionCallbacks(params: {
  state: ChatPageHost;
  layout: SidebarLayout;
  closePanelSlot: (slot: SidebarSlotId) => void;
  openPanelSlot: (slot: SidebarSlotId) => void;
  forgetDiscussionUrl: () => void;
  resizePanel: (columnId: string, size: number) => void;
  setPanelOpen: (open: boolean) => void;
}): SidebarRegionCallbacks {
  const { layout, state } = params;
  return {
    activatePanel: (panelId) => {
      const slot = layout.columns[0]?.panels.find((panel) => panel.id === panelId)?.slot;
      if (slot === "dashboard" && !isSidebarSlotVisible(layout, "dashboard")) {
        params.openPanelSlot(slot);
      } else {
        state.updateSidebarLayout(activatePanel(layout, panelId));
      }
      state.updateSidebarActivePanel(panelId);
    },
    togglePanelExpanded: (panelId) => {
      state.updateSidebarLayout(toggleSidebarPanelExpanded(layout, panelId), {
        dashboardPresentation: "personal",
      });
      state.updateSidebarActivePanel(panelId);
    },
    closeSlot: (slot) => {
      if (slot === "conversation") {
        params.setPanelOpen(false);
        return;
      }
      if (slot === "discussion") {
        params.forgetDiscussionUrl();
      }
      params.closePanelSlot(slot);
    },
    openSlot: params.openPanelSlot,
    reorderPanel: (panelId, targetPanelId, placement) =>
      state.updateSidebarLayout(reorderPanel(layout, panelId, targetPanelId, placement)),
    resizePanel: params.resizePanel,
    setOpen: params.setPanelOpen,
  };
}

export function renderSidebarRegion(params: SidebarRegionParams) {
  const panelIdPrefix = `chat-panel-${encodeURIComponent(params.presentationId)}`;
  let panelDefinitions = params.panelDefinitions ?? sidebarPanelDefinitions();
  const hasPanels = params.layout.columns.length > 0;
  const regionError = hasPanels ? ensureLazySidebarElement("region") : undefined;
  for (const panel of params.layout.columns[0]?.panels ?? []) {
    // A saved dashboard stays cold until its pane actually presents it.
    if (panel.slot === "dashboard" && !isSidebarSlotVisible(params.layout, "dashboard")) {
      continue;
    }
    const lazyState = ensureLazySidebarElement(panel.slot);
    if (lazyState !== undefined) {
      panelDefinitions = panelDefinitions.map((definition) =>
        definition.slot === panel.slot
          ? {
              ...definition,
              loadState: lazyState,
            }
          : definition,
      );
    }
  }
  return {
    ...params,
    panelIdPrefix,
    panelDefinitions,
    regionError,
  };
}

export function resolveSidebarLayoutForBoard(params: {
  board: ResolvedBoardView;
  layout: SidebarLayout;
  paneWidth: number;
}): SidebarLayout {
  let layout = params.layout;
  if (!params.board.available) {
    layout = closeSlot(layout, "dashboard");
  } else if (params.board.face === "dashboard" && layout.columns.length === 0) {
    layout = openSlot(layout, "dashboard");
  }
  return fitSidebarLayout(layout, params.paneWidth) ?? layout;
}

type FullMessageScope = ReturnType<typeof readSidebarFullMessageScope>;

function readSidebarFullMessageScope(state: ChatPageHost, gateway: ApplicationGateway) {
  const auth = gateway.snapshot.hello?.auth;
  const session = selectedChatSessionRow(state);
  return {
    owner: gatewayPresentationScope(gateway),
    sessionKey: state.sessionKey,
    agentId: resolveChatAgentId(state),
    sessionId: session?.sessionId,
    displayedSessionId: state.currentSessionId ?? undefined,
    lifecycleRevision: session?.lifecycleRevision,
    authorizationKey: JSON.stringify([
      state.mediaPolicyEpoch ?? 0,
      auth?.role,
      (auth?.scopes ?? []).toSorted(),
    ]),
  };
}

type FullMessageCache = FullMessageScope & {
  messages: Map<string, Awaited<ReturnType<SidebarFullMessageLoader>>>;
};
const fullMessageCaches = new WeakMap<object, FullMessageCache>();

export function createSidebarFullMessageLoader(
  state: ChatPageHost,
  gateway: ApplicationGateway,
): SidebarFullMessageLoader | null {
  if (parseCatalogSessionKey(state.sessionKey) || !state.client || !state.connected) {
    return null;
  }
  const readScope = () => readSidebarFullMessageScope(state, gateway);
  return async (request) => {
    if (!state.client || !state.connected) {
      return null;
    }
    const client = state.client;
    const generation = state.connectionEpoch;
    const scope = readScope();
    const sameScope = (other: FullMessageScope) =>
      scope.owner === other.owner &&
      scope.sessionKey === other.sessionKey &&
      scope.agentId === other.agentId &&
      scope.sessionId === other.sessionId &&
      scope.displayedSessionId === other.displayedSessionId &&
      scope.lifecycleRevision === other.lifecycleRevision &&
      scope.authorizationKey === other.authorizationKey;
    let cache = fullMessageCaches.get(state);
    if (!cache || !sameScope(cache)) {
      cache = { ...scope, messages: new Map() };
      fullMessageCaches.set(state, cache);
    }
    const maxChars = request.maxChars ?? DETAIL_FULL_MESSAGE_MAX_CHARS;
    const pendingInput = request.messageId.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX);
    const sameConversation = uiConversationMatches(
      state,
      scope.sessionKey,
      request.sessionKey,
      request.agentId,
      scope.agentId,
    );
    const sessionId =
      request.sessionId ??
      (sameConversation && !pendingInput && scope.displayedSessionId !== scope.sessionId
        ? scope.displayedSessionId
        : undefined);
    const cacheable =
      !pendingInput &&
      sameConversation &&
      scope.sessionId !== undefined &&
      scope.sessionId === scope.displayedSessionId &&
      (sessionId === undefined || sessionId === scope.sessionId) &&
      scope.lifecycleRevision !== undefined;
    const key = JSON.stringify([scope.sessionKey, scope.agentId, request.messageId, maxChars]);
    const cached = cacheable ? cache.messages.get(key) : undefined;
    if (cached) {
      return cached;
    }
    const result = await client.request<Awaited<ReturnType<SidebarFullMessageLoader>>>(
      "chat.message.get",
      {
        sessionKey: request.sessionKey,
        ...(request.agentId ? { agentId: request.agentId } : {}),
        ...(sessionId ? { sessionId } : {}),
        messageId: request.messageId,
        maxChars,
      },
    );
    if (
      !state.connected ||
      state.client !== client ||
      state.connectionEpoch !== generation ||
      !sameScope(readScope())
    ) {
      return null;
    }
    const message = asOptionalRecord(result?.message);
    if (
      cacheable &&
      result?.ok &&
      message &&
      !asOptionalRecord(message["__openclaw"])?.importedFrom &&
      !(message.role === "assistant" && message.stopReason === "error")
    ) {
      // Imported content and retry-hidden errors can change without a session lifecycle change.
      if (cache.messages.size >= 16) {
        cache.messages.delete(cache.messages.keys().next().value!);
      }
      cache.messages.set(key, result);
    }
    return result;
  };
}
