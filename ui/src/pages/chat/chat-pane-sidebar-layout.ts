import { html, nothing, type TemplateResult } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ensureCustomElementDefined } from "../../app/lazy-custom-element.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import { renderLazyViewError } from "../../components/lazy-view-error.ts";
import { renderPanelEmptyState } from "../../components/panel-empty-state.ts";
import { t } from "../../i18n/index.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type {
  SidebarPanelDefinition,
  SidebarPanelTemplates,
  SidebarRegionCallbacks,
} from "./components/chat-sidebar-region-types.ts";
import type { SidebarFullMessageLoader } from "./components/chat-sidebar.ts";
import type { LinkFaviconFetcher } from "./link-favicon-loader.ts";
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

type LazyElementKey = "region" | SidebarSlotId;
type LazyElement = readonly [tagName: string, loadModule: () => Promise<unknown>];

const LAZY_SIDEBAR_ELEMENTS: Partial<Record<LazyElementKey, LazyElement>> = {
  region: [
    "openclaw-chat-sidebar-region",
    () => import("./components/chat-sidebar-region.runtime.ts"),
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
  workspace: ["openclaw-chat-files-panel", () => import("./components/chat-files-panel.ts")],
  discussion: [
    "openclaw-session-discussion",
    () => import("./components/session-discussion-panel.ts"),
  ],
};

const lazyRuntimes = new Map<LazyElementKey, LazyPanelRuntime>();

function ensureLazyElement(
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

/** A native dock uses the same lazy component and empty state without the web region chrome. */
export function renderEmbeddedSidebarPanel(
  definition: SidebarPanelDefinition,
  requestUpdate: () => void,
): TemplateResult | typeof nothing {
  const lazy = definition.available ? ensureLazyElement(definition.slot, requestUpdate) : undefined;
  return lazy === null
    ? definition.loading
    : (lazy ??
        definition.content ??
        renderPanelEmptyState({
          icon: definition.icon,
          heading: definition.label,
          ...definition.empty,
        }));
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
  availableSlots: SidebarSlotId[];
  layout: SidebarLayout;
  narrow: boolean;
  panelDefinitions?: SidebarPanelDefinition[];
  panelActions: SidebarPanelTemplates;
  panelTemplates: SidebarPanelTemplates;
  header?: TemplateResult | typeof nothing;
  primary: TemplateResult;
  requestUpdate: () => void;
}): TemplateResult {
  const panelIdPrefix = `chat-panel-${encodeURIComponent(params.presentationId)}`;
  const panelDefinitions = params.panelDefinitions ?? sidebarPanelDefinitions();
  const panelOpen = params.layout.open === true;
  const hasPanels = params.layout.columns.length > 0;
  const regionError = hasPanels ? ensureLazyElement("region", params.requestUpdate) : undefined;
  let panelTemplates: SidebarPanelTemplates | null = null;
  for (const panel of params.layout.columns[0]?.panels ?? []) {
    const lazyState = ensureLazyElement(panel.slot, params.requestUpdate);
    if (lazyState !== undefined) {
      panelTemplates ??= { ...params.panelTemplates };
      panelTemplates[panel.slot] =
        lazyState ?? panelDefinitions.find((definition) => definition.slot === panel.slot)?.loading;
    }
  }
  const availableWidth =
    params.availableWidth > 0 ? params.availableWidth : Number.POSITIVE_INFINITY;
  const collapsed = params.narrow || availableWidth < SIDEBAR_NARROW_BREAKPOINT_PX;
  const main = sidebarMainPanel(params.layout);
  const chatMain = !main || main.slot === "conversation";
  const column = params.layout.columns[0];
  const activePanelId = params.layout.columns[0]?.activePanelId;
  const activePanelSlot = params.layout.columns[0]?.panels.find(
    (panel) => panel.id === activePanelId,
  )?.slot;
  const regionLoading = panelDefinitions.find(
    (definition) => definition.slot === activePanelSlot,
  )?.loading;
  return html`<div
    class="sidebar-region ${collapsed ? "sidebar-region--narrow" : ""} ${
      params.layout.expanded ? "sidebar-region--expanded" : ""
    } ${params.layout.expanded && params.layout.expandedSide ? "sidebar-region--expanded-side" : ""} sidebar-region--${sidebarDock(params.layout)} ${panelOpen ? "sidebar-region--open" : ""}"
    style=${styleMap({
      "--side-panel-width": `${column?.width ?? 480}px`,
      "--side-panel-height": `${column?.height ?? 360}px`,
    })}
  >
    <div class="sidebar-region__header">${params.header ?? nothing}</div>
    ${
      regionError !== undefined
        ? regionError === null
          ? (regionLoading ?? null)
          : null
        : html`<openclaw-chat-sidebar-region
            .panelIdPrefix=${panelIdPrefix}
            .conversationTab=${params.conversationTab}
            .layout=${params.layout}
            .fetchFavicon=${params.fetchFavicon}
            .panelDefinitions=${panelDefinitions}
            .panelTemplates=${panelTemplates ?? params.panelTemplates}
            .panelActions=${params.panelActions}
            .availableSlots=${params.availableSlots}
            .callbacks=${params.callbacks}
            .narrow=${params.narrow}
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

export function createSidebarFullMessageLoader(
  state: { client: GatewayBrowserClient | null; connected: boolean },
  disabled: boolean,
): SidebarFullMessageLoader | null {
  if (disabled || !state.client || !state.connected) {
    return null;
  }
  return async (request) => {
    if (!state.client || !state.connected) {
      return null;
    }
    const client = state.client;
    const result = await client.request<Awaited<ReturnType<SidebarFullMessageLoader>>>(
      "chat.message.get",
      {
        sessionKey: request.sessionKey,
        ...(request.agentId ? { agentId: request.agentId } : {}),
        messageId: request.messageId,
        maxChars: request.maxChars ?? DETAIL_FULL_MESSAGE_MAX_CHARS,
      },
    );
    return state.connected && state.client === client ? result : null;
  };
}
