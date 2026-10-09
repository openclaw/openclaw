import {
  html,
  nothing,
  render as renderTemplate,
  type PropertyValues,
  type TemplateResult,
} from "lit";
import "../../../styles/chat/side-panel.css";
import "./chat-files-panel.tsx";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { beginNativeWindowDrag } from "../../../app/native-window-drag.ts";
import { icons } from "../../../components/icons.ts";
import { renderKeyboardShortcut } from "../../../components/kbd.ts";
import { renderPanelEmptyState } from "../../../components/panel-empty-state.ts";
import {
  PANEL_HOSTED_TABS_CHANGE_EVENT,
  readPanelHostedTabs,
  type PanelHostedTab,
} from "../../../components/panel-hosted-tabs.ts";
import { renderPanelTabStrip, type PanelTabStripTab } from "../../../components/panel-tab-strip.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  LINK_READER_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
  type PanelToggleElement,
} from "../../../components/panel-toggle-contract.ts";
import { t } from "../../../i18n/index.ts";
import "../../../components/tooltip.ts";
import { cancelLayout, scheduleLayout } from "../../../lib/layout-frame.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { sidebarPanelDefinitions } from "../chat-pane-embedded-panels.ts";
import { readLinkFavicon, type LinkFaviconFetcher } from "../link-favicon-cache.ts";
import {
  SIDEBAR_GEOMETRY_COMMIT_EVENT,
  SIDEBAR_MIN_HEIGHT_PX,
  SIDEBAR_MIN_WIDTH_PX,
  sidebarDock,
  sidebarMainPanel,
  sidebarSidePanels,
  sidebarActivePanel,
  isSidebarSlotVisible,
  type SidebarColumn,
  type SidebarLayout,
  type SidebarPanel,
  type SidebarSlotId,
} from "../sidebar-layout.ts";
import { renderChatResizableDivider } from "./chat-resizable-divider.ts";
import type {
  SidebarPanelDefinition,
  SidebarRegionCallbacks,
} from "./chat-sidebar-region-types.ts";

function panelType(
  definitions: SidebarPanelDefinition[],
  slot: SidebarSlotId,
): SidebarPanelDefinition {
  const definition = definitions.find((candidate) => candidate.slot === slot);
  if (!definition) {
    throw new Error(`Missing sidebar panel definition for ${slot}`);
  }
  return definition;
}

function renderPanelTypeOption(type: SidebarPanelDefinition, slotted = false) {
  return html`
    <span slot=${slotted ? "icon" : nothing} class="side-panel-type-option__icon" aria-hidden="true"
      >${type.icon}</span
    >
    <span class="side-panel-type-option__label">${type.label}</span>
    ${
      type.shortcut
        ? renderKeyboardShortcut(type.shortcut, {
            slot: slotted ? "details" : undefined,
            className: "side-panel-type-option__shortcut",
          })
        : nothing
    }
  `;
}

const HOSTED_TAB_REQUESTS = [
  ["browser", BROWSER_PANEL_TOGGLE_EVENT, { open: true, newTab: true }],
  ["link-reader", LINK_READER_PANEL_TOGGLE_EVENT, { open: true, newTab: true }],
  ["terminal", TERMINAL_PANEL_TOGGLE_EVENT, { open: true, newSession: true }],
] as const;

// The Solid strip writes active before Web Awesome reflects its attribute.
function activePanelTab(root: ParentNode | null | undefined) {
  return [...(root?.querySelectorAll<HTMLElementTagNameMap["wa-tab"]>("wa-tab") ?? [])].find(
    (tab) => tab.active,
  );
}

class ChatSidebarRegion extends OpenClawLightDomElement {
  @property({ attribute: false }) panelIdPrefix = "";
  @property({ attribute: false }) conversationTab?: Pick<SidebarPanelDefinition, "label" | "icon">;
  @property({ attribute: false }) layout: SidebarLayout = { columns: [] };
  @property({ attribute: false }) panelDefinitions = sidebarPanelDefinitions();
  @property({ attribute: false }) fetchFavicon?: LinkFaviconFetcher;
  @property({ attribute: false }) callbacks: SidebarRegionCallbacks | null = null;
  @property({ type: Boolean }) narrow = false;
  /** A narrow pane shows the active panel focused whatever the layout says; nothing to restore. */
  @property({ type: Boolean }) sideFocusLocked = false;
  /** The control the pane saw open the panel there, taken once; see moveFocusWithSideLock. */
  @property({ attribute: false }) sideFocusOrigin?: () => HTMLElement | null;
  @property({ type: Number }) availableWidth = 0;
  private previousGeometry = "";
  private contentMounted = false;
  private focusedSurface: Element | null = null;
  private focusBeforeSideLock: HTMLElement | null = null;
  private nativeCloseListeners: AbortController | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.nativeCloseListeners = new AbortController();
    const options = { capture: true, signal: this.nativeCloseListeners.signal };
    this.parentElement?.addEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, this.refreshHostedTabs, {
      signal: this.nativeCloseListeners.signal,
    });
    // The region renders its content into siblings, not into this element.
    // Document focus also clears the owner when another pane or chrome wins it.
    document.addEventListener("pointerdown", this.trackFocus, options);
    document.addEventListener("focusin", this.trackFocus, options);
    window.addEventListener("openclaw:native-close-focused-panel", this.closeFocusedPanel, options);
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    this.nativeCloseListeners?.abort();
    this.nativeCloseListeners = undefined;
    this.focusedSurface = null;
    cancelLayout(this);
    super.disconnectedCallback();
  }

  private readonly refreshHostedTabs = (): void => this.requestUpdate();

  private readonly trackFocus = (event: Event): void => {
    const surface = event
      .composedPath()
      .find(
        (node): node is Element =>
          node instanceof Element && node.matches("[data-region], [data-region-header]"),
      );
    this.focusedSurface =
      surface && surface.closest(".sidebar-region") === this.parentElement ? surface : null;
  };

  private readonly closeFocusedPanel = (event: Event): void => {
    if (
      event.defaultPrevented ||
      !this.layout.open ||
      (this.layout.expanded && !this.layout.expandedSide) ||
      !this.callbacks
    ) {
      return;
    }
    const browserScope = event instanceof CustomEvent ? event.detail?.browserScope : undefined;
    // Native browser content is a separate NSView, so its responder scope is
    // authoritative over the dashboard document's previous DOM focus.
    const browser =
      typeof browserScope === "string"
        ? [
            ...(this.parentElement?.querySelectorAll<HTMLElement>("[data-native-browser-scope]") ??
              []),
          ].find((element) => element.dataset.nativeBrowserScope === browserScope)
        : undefined;
    const frame =
      document.activeElement instanceof HTMLIFrameElement
        ? document.activeElement.closest("[data-region]")
        : null;
    const surface =
      typeof browserScope === "string"
        ? browser?.closest("[data-region]")
        : (frame ?? this.focusedSurface);
    const active = sidebarActivePanel(this.layout);
    if (
      !active ||
      !surface?.isConnected ||
      surface.closest(".sidebar-region") !== this.parentElement ||
      !surface.matches('[data-region="side"], [data-region-header="side"]') ||
      surface.closest('[hidden], [inert], [aria-hidden="true"]') ||
      document.openClawModalLayers?.size ||
      document.querySelector("dialog[open], [aria-modal='true']")
    ) {
      return;
    }
    event.preventDefault();
    // Keep successive Close commands in the tab strip after its content unmounts.
    const header = this.parentElement?.querySelector('[data-region-header="side"]') ?? null;
    this.focusedSurface = header;
    const restoreFocus = () => {
      if (this.layout.open && this.focusedSurface === header && header?.isConnected) {
        activePanelTab(header)?.focus();
      }
    };
    const hosted = this.hostedTabsElement(active);
    const hostedTabId = hosted?.activeHostedTabId;
    if (hosted && hostedTabId && hosted.hostedTabs.some((tab) => tab.id === hostedTabId)) {
      // The focused header tab is one page, not the panel; the owner's change
      // event re-renders the strip once that page is gone.
      void hosted
        .closeHostedTab(hostedTabId)
        .then(() => this.updateComplete)
        .then(restoreFocus);
      return;
    }
    this.callbacks.closeSlot(active.slot);
    // The callback invalidates the parent first; await this region's next commit.
    this.requestUpdate();
    void this.updateComplete.then(restoreFocus);
  };

  private hostedTabsElement(panel: SidebarPanel) {
    return readPanelHostedTabs(
      this.parentElement?.querySelector(`[data-panel-slot="${panel.slot}"]`)?.firstElementChild,
    );
  }

  deliverPanelEvent(slot: SidebarSlotId, event: Event): boolean {
    const panel = this.parentElement?.querySelector<HTMLElement>(
      `[data-panel-slot="${slot}"]`,
    )?.firstElementChild;
    if (
      !(panel instanceof HTMLElement) ||
      typeof (panel as Partial<PanelToggleElement>).handleToggleRequest !== "function"
    ) {
      return false;
    }
    (panel as PanelToggleElement).handleToggleRequest(event);
    return true;
  }

  private panelTypes(): SidebarPanelDefinition[] {
    return this.panelDefinitions.filter((definition) => definition.available);
  }

  private renderTypeMenu() {
    const openSlots = new Set((this.layout.columns[0]?.panels ?? []).map((panel) => panel.slot));
    return html`
      <wa-dropdown
        class="side-panel-type-menu"
        placement="bottom-start"
        @wa-select=${(event: CustomEvent<{ item: { value?: SidebarSlotId } }>) => {
          const slot = event.detail.item.value;
          if (slot) {
            this.callbacks?.openSlot(slot);
            const request = HOSTED_TAB_REQUESTS.find(([panel]) => panel === slot);
            if (request && openSlots.has(slot)) {
              this.deliverPanelEvent(
                slot,
                new CustomEvent(request[1], { detail: { ...request[2] } }),
              );
            }
          }
        }}
      >
        <button
          slot="trigger"
          class="rail-header__action side-panel-type-menu__trigger"
          type="button"
          aria-label=${t("chat.sidePanel.addTab")}
          title=${t("chat.sidePanel.addTab")}
        >
          ${icons.plus}
        </button>
        ${this.panelTypes()
          .filter(
            (type) =>
              HOSTED_TAB_REQUESTS.some(([slot]) => slot === type.slot) || !openSlots.has(type.slot),
          )
          .map(
            (type) => html`
              <wa-dropdown-item
                class="side-panel-type-menu__item session-menu__item"
                .value=${type.slot}
              >
                ${renderPanelTypeOption(type, true)}
              </wa-dropdown-item>
            `,
          )}
      </wa-dropdown>
    `;
  }

  private renderHostedTabIcon(tab: PanelHostedTab) {
    if (tab.favicon) {
      return html`<img class="tabstrip-tab__favicon" src=${tab.favicon} alt="" />`;
    }
    const hostname = tab.url ? URL.parse(tab.url)?.hostname : "";
    const favicon =
      hostname && this.fetchFavicon
        ? readLinkFavicon(hostname, this.fetchFavicon, this.refreshHostedTabs)
        : null;
    return favicon ? html`<img class="tabstrip-tab__favicon" src=${favicon} alt="" />` : tab.icon;
  }

  private renderHeader(column: SidebarColumn) {
    const sidePanels = sidebarSidePanels(this.layout);
    const hostedPanels = sidePanels.flatMap((panel) => {
      const element = this.hostedTabsElement(panel);
      return element ? [{ panel, element, tabs: element.hostedTabs }] : [];
    });
    const resolveHostedTab = (id: string) => {
      for (const hosted of hostedPanels) {
        const prefix = `hosted:${hosted.panel.id}:`;
        if (id.startsWith(prefix)) {
          const tabId = id.slice(prefix.length);
          if (hosted.tabs.some((tab) => tab.id === tabId)) {
            return { ...hosted, tabId };
          }
        }
      }
      return null;
    };
    const tabs = sidePanels.flatMap((panel): (PanelTabStripTab & { contentId: string })[] => {
      const contentId = `${this.panelIdPrefix}-${encodeURIComponent(panel.slot)}`;
      const hosted = hostedPanels.find((entry) => entry.panel.id === panel.id);
      if (hosted?.tabs.length) {
        return hosted.tabs.map((tab) => ({
          id: `hosted:${panel.id}:${tab.id}`,
          domId: `${this.panelIdPrefix}-tab-${encodeURIComponent(JSON.stringify([panel.id, tab.id]))}`,
          contentId,
          label: tab.label,
          labelTooltip: tab.label,
          title: tab.title,
          icon: this.renderHostedTabIcon(tab),
          statusLabel: tab.statusLabel,
          badge: tab.badge,
          className: tab.className,
          closeLabel: `${t("browser.closeTab")}: ${tab.label}`,
          group: panel.id,
          draggable: false,
          reorderId: panel.id,
        }));
      }
      const type = panelType(this.panelDefinitions, panel.slot);
      // Agent transitions clear identity before loading the next name.
      const tab =
        panel.slot === "conversation" && this.conversationTab?.label ? this.conversationTab : type;
      return [
        {
          id: panel.id,
          domId: `${this.panelIdPrefix}-tab-${encodeURIComponent(panel.id)}`,
          contentId,
          label: tab.label,
          labelTooltip:
            panel.slot === "dashboard"
              ? t(
                  this.layout.expanded &&
                    this.layout.expandedSide &&
                    column.activePanelId === panel.id
                    ? "chat.sidePanel.restore"
                    : "chat.sidePanel.expandPanel",
                  { panel: type.label },
                )
              : tab.label,
          onActivate:
            panel.slot === "dashboard"
              ? () => this.callbacks?.togglePanelExpanded(panel.id)
              : undefined,
          icon: tab.icon,
          closeLabel: t("chat.sidebarColumns.close", { panel: type.label }),
        },
      ];
    });
    const active = sidebarActivePanel(this.layout);
    const activeHosted = hostedPanels.find((entry) => entry.panel.id === active?.id);
    const activeId = activeHosted?.tabs.some(
      (tab) => tab.id === activeHosted.element.activeHostedTabId,
    )
      ? `hosted:${activeHosted.panel.id}:${activeHosted.element.activeHostedTabId}`
      : (active?.id ?? null);
    const activePanel = column.panels.find((panel) => panel.id === active?.id);
    const activeActions =
      (activePanel ? panelType(this.panelDefinitions, activePanel.slot).headerAction : null) ??
      null;
    return html`
      <header
        class="rail-header side-panel__header"
        data-region-header="side"
        @mousedown=${beginNativeWindowDrag}
      >
        <div class="side-panel__header-tabs">
          ${renderPanelTabStrip({
            tabs,
            activeId,
            ariaControls: (tab) => tab.contentId,
            onSelect: (panelId) => {
              const hosted = resolveHostedTab(panelId);
              if (hosted) {
                if (column.activePanelId !== hosted.panel.id) {
                  this.callbacks?.activatePanel(hosted.panel.id);
                }
                hosted.element.selectHostedTab(hosted.tabId);
              } else {
                this.callbacks?.activatePanel(panelId);
              }
            },
            onClose: async (panelId) => {
              const hosted = resolveHostedTab(panelId);
              if (hosted) {
                await hosted.element.closeHostedTab(hosted.tabId);
                return;
              }
              const panel = column.panels.find((entry) => entry.id === panelId);
              if (panel) {
                this.callbacks?.closeSlot(panel.slot);
              }
            },
            onNew: () => undefined,
            newLabel: t("chat.sidePanel.addTab"),
            newControl: nothing,
            separateTabs: true,
            onReorder: (panelId, targetPanelId, placement) =>
              this.callbacks?.reorderPanel(panelId, targetPanelId, placement),
          })}
          ${this.renderTypeMenu()}
        </div>
        ${this.renderHeaderActions(activeActions, activeHosted?.element.hostedActions ?? nothing)}
      </header>
    `;
  }

  private renderHeaderActions(
    panelActions: TemplateResult | typeof nothing | null,
    hostedActions: TemplateResult | Node | typeof nothing,
  ) {
    const active = sidebarActivePanel(this.layout);
    const expanded = this.layout.expanded === true && this.layout.expandedSide === true;
    const expandLabel = expanded
      ? t("chat.sidePanel.restore")
      : t("chat.sidePanel.expandPanel", {
          panel: active ? panelType(this.panelDefinitions, active.slot).label : "",
        });
    return html`<div class="rail-header__actions side-panel__actions">
      ${
        panelActions || hostedActions !== nothing
          ? html`<span class="side-panel__action-group side-panel__action-group--content">
              ${hostedActions} ${panelActions}
            </span>`
          : nothing
      }
      <span class="side-panel__action-group side-panel__action-group--close">
        ${
          active && !this.sideFocusLocked
            ? html`<openclaw-tooltip .content=${expandLabel}>
                <button
                  class="rail-header__action side-panel__expand"
                  type="button"
                  aria-label=${expandLabel}
                  aria-pressed=${String(expanded)}
                  @click=${() => this.callbacks?.togglePanelExpanded(active.id)}
                >
                  ${expanded ? icons.minimize : icons.maximize}
                </button>
              </openclaw-tooltip>`
            : nothing
        }
        <openclaw-tooltip .content=${t("common.close")}>
          <button
            class="rail-header__action side-panel__minimize"
            type="button"
            aria-label=${t("common.close")}
            @click=${() => this.callbacks?.setOpen(false)}
          >
            ${icons.x}
          </button>
        </openclaw-tooltip>
      </span>
    </div>`;
  }

  private renderEmpty(panel?: SidebarPanel) {
    if (panel) {
      const type = panelType(this.panelDefinitions, panel.slot);
      return html`<div class="side-panel-empty side-panel-empty--type">
        ${renderPanelEmptyState({
          icon: type.icon,
          heading: type.label,
          description: type.empty.description,
          action: type.empty.action,
        })}
      </div>`;
    }
    return html`<div class="side-panel-empty side-panel-empty--selector">
      <div class="side-panel-empty__types">
        ${this.panelTypes().map(
          (type) => html`<button
            class="side-panel-empty__type"
            type="button"
            @click=${() => this.callbacks?.openSlot(type.slot)}
          >
            ${renderPanelTypeOption(type)}
          </button>`,
        )}
      </div>
    </div>`;
  }

  private renderBody(column?: SidebarColumn) {
    return html`<div class="side-panel__body">
      ${repeat(
        // Tab reordering must not physically move live iframe/custom-element roots.
        this.panelDefinitions.flatMap((definition) =>
          (column?.panels ?? []).filter(
            (panel) => panel.slot === definition.slot && panel.slot !== "conversation",
          ),
        ),
        (panel) => panel.id,
        (panel) => html`<div
          id=${`${this.panelIdPrefix}-${encodeURIComponent(panel.slot)}`}
          class="side-panel__panel"
          role="region"
          aria-label=${panelType(this.panelDefinitions, panel.slot).label}
          data-panel-slot=${panel.slot}
          data-region=${panel.id === this.layout.mainPanelId ? "main" : "side"}
          ?hidden=${!isSidebarSlotVisible(this.layout, panel.slot)}
        >
          ${panelType(this.panelDefinitions, panel.slot).content ?? this.renderEmpty(panel)}
        </div>`,
      )}
      ${
        sidebarSidePanels(this.layout).length === 0
          ? html`<div class="side-panel__empty-body" data-region="side">${this.renderEmpty()}</div>`
          : nothing
      }
    </div>`;
  }

  private renderDivider(column: SidebarColumn) {
    const dock = sidebarDock(this.layout);
    const dimension = dock === "bottom" ? "height" : "width";
    const measure = () => {
      const shell = this.parentElement;
      const primary = shell?.querySelector<HTMLElement>('[data-region="main"]');
      const panel = shell?.querySelector<HTMLElement>('[data-region="side"]:not([hidden])');
      const primarySize = primary?.getBoundingClientRect()[dimension] ?? 0;
      const panelSize = panel?.getBoundingClientRect()[dimension] ?? column[dimension];
      // Grid columns mirror in RTL; divider ratios follow physical left/top movement.
      const panelBeforeMain =
        dock !== "bottom" &&
        (dock === "left") !== (getComputedStyle(shell ?? this).direction === "rtl");
      return { primarySize, panelSize, panelBeforeMain, total: primarySize + panelSize };
    };
    return renderChatResizableDivider({
      className: "sidebar-column__divider",
      label: t("chat.sidePanel.resize"),
      orientation: dock === "bottom" ? "horizontal" : "vertical",
      splitRatio: 0.5,
      minRatio: 0.05,
      maxRatio: 0.95,
      measureRatio: () => {
        const { primarySize, panelSize, panelBeforeMain, total } = measure();
        return total > 0 ? (panelBeforeMain ? panelSize : primarySize) / total : 0.5;
      },
      measureSize: () => measure().total,
      onResize: (event) => {
        const bounds = this.parentElement?.getBoundingClientRect();
        const regionSize =
          dimension === "width" && this.availableWidth > 0
            ? this.availableWidth
            : (bounds?.[dimension] ?? 0);
        const measured = measure();
        const total = measured.total || regionSize;
        const requested =
          total *
          (measured.panelBeforeMain ? event.detail.splitRatio : 1 - event.detail.splitRatio);
        const minimum = dock === "bottom" ? SIDEBAR_MIN_HEIGHT_PX : SIDEBAR_MIN_WIDTH_PX;
        const maximum = Math.max(minimum, regionSize * 0.6);
        this.callbacks?.resizePanel(column.id, Math.max(minimum, Math.min(requested, maximum)));
      },
    });
  }

  private renderPanel() {
    const column = this.layout.columns[0];
    if (!column) {
      this.contentMounted = false;
      return nothing;
    }
    // Saved closed panels stay dormant until first shown. Once mounted, their
    // content survives hiding; closing tabs or this region releases it.
    this.contentMounted ||=
      (this.layout.open === true && (!this.layout.expanded || this.layout.expandedSide === true)) ||
      (sidebarMainPanel(this.layout)?.slot ?? "conversation") !== "conversation";
    return html`${
        !this.narrow && this.layout.open && !this.layout.expanded
          ? this.renderDivider(column)
          : nothing
      }
      <div class="side-panel">
        ${sidebarSidePanels(this.layout).length > 0 ? this.renderHeader(column) : nothing}
        ${this.contentMounted ? this.renderBody(column) : nothing}
      </div>`;
  }

  protected override updated(changed: PropertyValues<this>) {
    const root = this.parentElement?.querySelector<HTMLElement>(".sidebar-region__right-runtime");
    if (root) {
      renderTemplate(this.renderPanel(), root);
      this.scheduleGeometryCommit();
    }
    if (changed.has("sideFocusLocked")) {
      this.moveFocusWithSideLock(root);
    }
  }

  /**
   * A narrow pane puts the side panel in the main view's place, hiding whatever
   * held focus there. Focus continues on the panel's tab, and goes back to that
   * control once the panel is closed.
   */
  private moveFocusWithSideLock(side: HTMLElement | null | undefined): void {
    const region = this.parentElement;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inSide = Boolean(active && side?.contains(active));
    if (this.sideFocusLocked) {
      // The first panel a pane opens mounts this component after the browser
      // has dropped focus from the hidden view; the pane then says what held it.
      const given = this.sideFocusOrigin?.() ?? null;
      const origin = active && region?.contains(active) && !inSide ? active : given;
      // A pane that merely loads this way has neither, and takes no focus.
      if (origin) {
        this.focusBeforeSideLock = origin;
        // A tab strip rendered just now is focusable from its next frame.
        requestAnimationFrame(() => {
          const now = document.activeElement;
          const moved = now instanceof HTMLElement && now !== document.body && now !== origin;
          if (this.sideFocusLocked && !moved) {
            activePanelTab(side?.querySelector('[data-region-header="side"]'))?.focus();
          }
        });
      }
      return;
    }
    const before = this.focusBeforeSideLock;
    this.focusBeforeSideLock = null;
    const adrift = !active || active === document.body;
    // A panel that is still open, beside or under the main view, keeps the focus it has.
    if (!before || !(adrift || (inSide && this.layout.open !== true))) {
      return;
    }
    before.focus({ preventScroll: true });
    if (document.activeElement !== before) {
      // That control is gone by now; carry on from the main view's own header.
      region
        ?.querySelector<HTMLElement>(":scope > .sidebar-region__header button:not([disabled])")
        ?.focus({ preventScroll: true });
    }
  }

  private scheduleGeometryCommit() {
    scheduleLayout(this, () => {
      const shell = this.parentElement;
      if (!this.isConnected || !shell) {
        return undefined;
      }
      const panel = shell.querySelector<HTMLElement>(
        ".sidebar-region__right-runtime > .side-panel",
      );
      const geometry = Array.from(
        shell.querySelectorAll<HTMLElement>(".sidebar-region__primary, .side-panel__panel"),
        (content) =>
          `${content.dataset.panelSlot ?? "conversation"}:${content.getBoundingClientRect().width}`,
      ).join(":");
      // The manual panel render is the commit boundary for its transcript.
      // Track content, not region roles: swapping can keep the same main/side
      // widths while changing the transcript width and its row measurements.
      return () => {
        panel?.dispatchEvent(
          new CustomEvent(SIDEBAR_GEOMETRY_COMMIT_EVENT, {
            bubbles: true,
            detail: {
              widthChanged: geometry !== this.previousGeometry,
            },
          }),
        );
        this.previousGeometry = geometry;
      };
    });
  }

  override render() {
    return nothing;
  }
}

if (!customElements.get("openclaw-chat-sidebar-region")) {
  customElements.define("openclaw-chat-sidebar-region", ChatSidebarRegion);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-sidebar-region": ChatSidebarRegion;
  }
}
