import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { ensureCustomElementDefined } from "../../app/lazy-custom-element.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import { renderLazyViewError } from "../../components/lazy-view-error.ts";
import { t } from "../../i18n/index.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { uiConversationMatches } from "../../lib/sessions/session-key.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import type { SidebarFullMessageLoader } from "./components/chat-sidebar-content-types.ts";
import type {
  SidebarPanelDefinition,
  SidebarRegionCallbacks,
} from "./components/chat-sidebar-region-types.ts";
import type { LinkFaviconFetcher } from "./link-favicon-cache.ts";
import {
  activatePanel,
  toggleSidebarPanelExpanded,
  closeSlot,
  fitSidebarLayout,
  SIDEBAR_NARROW_BREAKPOINT_PX,
  openSlot,
  reorderPanel,
  sidebarDock,
  sidebarMainPanel,
  isSidebarSlotVisible,
  type SidebarLayout,
  type SidebarSlotId,
} from "./sidebar-layout.ts";

const DETAIL_FULL_MESSAGE_MAX_CHARS = 500_000;
type LazyPanelRuntime = {
  error?: TemplateResult;
  listeners: Set<() => void>;
  pending?: Promise<void>;
};

type LazyElementKey = "region" | "detail-panel" | SidebarSlotId;
type LazyElement = readonly [tagName: string, loadModule: () => Promise<unknown>];

const LAZY_SIDEBAR_ELEMENTS: Partial<Record<LazyElementKey, LazyElement>> = {
  region: [
    "openclaw-chat-sidebar-region",
    () => import("./components/chat-sidebar-region.runtime.ts"),
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
    () => import("../../components/link-reader-panel.ts"),
  ],
  browser: ["openclaw-browser-panel", () => import("../../components/browser/browser-panel.ts")],
  desktop: ["openclaw-desktop-panel", () => import("../../components/desktop/desktop-panel.ts")],
  portal: ["openclaw-portals-page", () => import("../portals/portals-page.ts")],
  companion: ["openclaw-chat-session-rail", () => import("./components/chat-session-rail.ts")],
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

export function ensureLazySidebarElement(
  key: LazyElementKey,
  requestUpdate: () => void,
): TemplateResult | null | undefined {
  const element = LAZY_SIDEBAR_ELEMENTS[key];
  if (!element) {
    return undefined;
  }
  const [tagName, loadModule] = element;
  if (customElements.get(tagName)) {
    lazyRuntimes.delete(key);
    return undefined;
  }
  const runtime = lazyRuntimes.get(key) ?? { listeners: new Set() };
  lazyRuntimes.set(key, runtime);
  if (runtime.error !== undefined) {
    return runtime.error;
  }
  runtime.listeners.add(requestUpdate);
  if (runtime.pending) {
    return null;
  }
  runtime.pending = ensureCustomElementDefined(tagName, loadModule)
    .catch((error: unknown) => {
      runtime.error = renderLazyViewError({
        error,
        stale: isStaleChunkImportError(error),
        onRetry: () => void retryStaleChunkReloadWhenReachable(),
      });
    })
    .finally(() => {
      delete runtime.pending;
      runtime.listeners.forEach((listener) => listener());
      runtime.listeners.clear();
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

export function renderSidebarRegion(params: {
  presentationId: string;
  conversationTab?: Pick<SidebarPanelDefinition, "label" | "icon">;
  fetchFavicon?: LinkFaviconFetcher;
  availableWidth: number;
  callbacks: SidebarRegionCallbacks;
  layout: SidebarLayout;
  narrow: boolean;
  /** The layout given is a narrow pane's view of the saved one; see presentNarrowSidebarLayout. */
  sideFocusLocked?: boolean;
  sideFocusOrigin?: () => HTMLElement | null;
  panelDefinitions?: SidebarPanelDefinition[];
  header?: TemplateResult | typeof nothing;
  background?: TemplateResult;
  primary: TemplateResult;
  requestUpdate: () => void;
}): TemplateResult {
  const panelIdPrefix = `chat-panel-${encodeURIComponent(params.presentationId)}`;
  let panelDefinitions = params.panelDefinitions ?? sidebarPanelDefinitions();
  const panelOpen = params.layout.open === true;
  const hasPanels = params.layout.columns.length > 0;
  const regionError = hasPanels
    ? ensureLazySidebarElement("region", params.requestUpdate)
    : undefined;
  for (const panel of params.layout.columns[0]?.panels ?? []) {
    const lazyState = ensureLazySidebarElement(panel.slot, params.requestUpdate);
    if (lazyState !== undefined) {
      panelDefinitions = panelDefinitions.map((definition) =>
        definition.slot === panel.slot
          ? { ...definition, content: lazyState ?? definition.loading }
          : definition,
      );
    }
  }
  const availableWidth =
    params.availableWidth > 0 ? params.availableWidth : Number.POSITIVE_INFINITY;
  const collapsed = params.narrow || availableWidth < SIDEBAR_NARROW_BREAKPOINT_PX;
  const main = sidebarMainPanel(params.layout);
  const chatMain = !main || main.slot === "conversation";
  const column = params.layout.columns[0];
  return html`<div
    class="sidebar-region ${params.background ? "sidebar-region--background" : ""} ${collapsed ? "sidebar-region--narrow" : ""} ${
      params.layout.expanded ? "sidebar-region--expanded" : ""
    } ${
      params.layout.expanded && params.layout.expandedSide ? "sidebar-region--expanded-side" : ""
    } sidebar-region--${sidebarDock(params.layout)} ${panelOpen ? "sidebar-region--open" : ""}"
    style=${styleMap({
      "--side-panel-width": `${column?.width ?? 480}px`,
      "--side-panel-height": `${column?.height ?? 360}px`,
    })}
  >
    ${
      params.background
        ? html`<div
            class="sidebar-region__background"
            ?hidden=${!isSidebarSlotVisible(params.layout, "conversation")}
            style=${styleMap({
              gridArea: chatMain
                ? "main-header / main-header / main / main"
                : "side-header / side-header / side / side",
            })}
          >
            ${params.background}
          </div>`
        : nothing
    }
    <div class="sidebar-region__header">${params.header ?? nothing}</div>
    ${
      regionError !== undefined
        ? regionError === null
          ? column?.panels
              .filter(
                (panel) =>
                  panel.slot !== "conversation" && isSidebarSlotVisible(params.layout, panel.slot),
              )
              .map(
                (panel) => html`<div
                  class="side-panel__panel"
                  data-region=${panel.id === params.layout.mainPanelId ? "main" : "side"}
                >
                  ${panelDefinitions.find((definition) => definition.slot === panel.slot)?.loading}
                </div>`,
              )
          : null
        : html`<openclaw-chat-sidebar-region
            .panelIdPrefix=${panelIdPrefix}
            .conversationTab=${params.conversationTab}
            .layout=${params.layout}
            .fetchFavicon=${params.fetchFavicon}
            .panelDefinitions=${panelDefinitions}
            .callbacks=${params.callbacks}
            .narrow=${params.narrow}
            .sideFocusLocked=${params.sideFocusLocked === true}
            .sideFocusOrigin=${params.sideFocusOrigin}
            .availableWidth=${params.availableWidth}
          ></openclaw-chat-sidebar-region>`
    }
    <div
      id=${`${panelIdPrefix}-conversation`}
      class="sidebar-region__primary"
      role="region"
      aria-label=${t("chat.sidePanel.conversation")}
      data-region=${chatMain ? "main" : "side"}
      ?hidden=${!isSidebarSlotVisible(params.layout, "conversation")}
    >
      ${params.primary}
    </div>
    <div class="sidebar-region__right-runtime">${regionError ?? null}</div>
  </div>`;
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

type FullMessageScope = {
  owner: object;
  sessionKey?: string;
  agentId?: string;
  sessionId?: string;
  displayedSessionId?: string;
  lifecycleRevision?: string;
  authorizationKey?: string;
};

function readSidebarFullMessageScope(
  state: ChatPageHost,
  gateway: ApplicationGateway,
): FullMessageScope {
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
    const scope = { ...readScope() };
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
