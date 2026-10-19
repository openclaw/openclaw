import "../../../styles/chat/side-panel.css";
import "./chat-files-panel.tsx";
import { render } from "@solidjs/web";
import { For, Show, createEffect, createMemo, createSignal, getOwner, onCleanup } from "solid-js";
import { PANEL_HOSTED_TABS_CHANGE_EVENT } from "../../../components/panel-hosted-tabs.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { cancelLayout, scheduleLayout } from "../../../lib/layout-frame.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { defineSolidBridge } from "../../../lib/solid-bridge.ts";
import { sidebarPanelDefinitions } from "../chat-pane-embedded-panels.ts";
import { SidebarPanel as SidebarPanelView } from "../chat-pane-embedded-view.tsx";
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
  type SidebarPanel,
  type SidebarSlotId,
} from "../sidebar-layout.ts";
import {
  SidebarRegionHeader,
  PanelTypeOption,
  sidebarPanelType,
  readRegionHostedTabs,
} from "./chat-sidebar-region-header.tsx";
import type {
  RegionProps,
  RegionElement,
  RegionMethods,
  SidebarPanelHost,
} from "./chat-sidebar-region-types.ts";

const regionOperations = new WeakMap<
  RegionElement,
  Pick<RegionMethods, "readPanelHost" | "focusActiveSideTab">
>();

function Region(props: RegionProps, host: RegionElement) {
  const panelHosts = new Map<SidebarSlotId, SidebarPanelHost>();
  let focusActiveTab: ((options?: FocusOptions) => void) | null = null;
  const focusActiveSideTab = (options?: FocusOptions) => focusActiveTab?.(options);
  regionOperations.set(host, {
    readPanelHost: (slot) =>
      panelHosts.get(slot) ??
      props.panelDefinitions.find((definition) => definition.slot === slot)?.panelHost ??
      null,
    focusActiveSideTab,
  });
  let panelElement: HTMLDivElement | undefined;
  let previousGeometry = "";
  let focusFrame: number | null = null;
  let focusedSurface: Element | null = null;
  let focusBeforeSideLock: HTMLElement | null = null;
  // Child panels publish hosted tabs synchronously while their parent commits.
  const [hostedRevision, setHostedRevision] = createSignal(0, { ownedWrite: true });
  const refreshHostedTabs = () => setHostedRevision((value) => value + 1);
  const panelHostRegistration = (initialSlot: SidebarSlotId) => (element: SidebarPanelHost) => {
    panelHosts.set(initialSlot, element);
    refreshHostedTabs();
    return () => {
      if (panelHosts.get(initialSlot) === element) {
        panelHosts.delete(initialSlot);
      }
    };
  };
  const trackFocus = (event: Event): void => {
    const surface = event
      .composedPath()
      .find(
        (node): node is Element =>
          node instanceof Element && node.matches("[data-region], [data-region-header]"),
      );
    focusedSurface =
      surface && surface.closest(".sidebar-region") === host.parentElement ? surface : null;
  };

  const closeFocusedPanel = (event: Event): void => {
    if (
      event.defaultPrevented ||
      !props.layout.open ||
      (props.layout.expanded && !props.layout.expandedSide) ||
      !props.callbacks
    ) {
      return;
    }
    const browserScope = event instanceof CustomEvent ? event.detail?.browserScope : undefined;
    // Native browser content is a separate NSView, so its responder scope is
    // authoritative over the dashboard document's previous DOM focus.
    const browser =
      typeof browserScope === "string"
        ? [
            ...(host.parentElement?.querySelectorAll<HTMLElement>("[data-native-browser-scope]") ??
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
        : (frame ?? focusedSurface);
    const active = sidebarActivePanel(props.layout);
    if (
      !active ||
      !surface?.isConnected ||
      surface.closest(".sidebar-region") !== host.parentElement ||
      !surface.matches('[data-region="side"], [data-region-header="side"]') ||
      surface.closest('[hidden], [inert], [aria-hidden="true"]') ||
      document.openClawModalLayers?.size ||
      document.querySelector("dialog[open], [aria-modal='true']")
    ) {
      return;
    }
    event.preventDefault();
    // Keep successive Close commands in the tab strip after its content unmounts.
    const header = host.parentElement?.querySelector('[data-region-header="side"]') ?? null;
    focusedSurface = header;
    const restoreFocus = () => {
      if (props.layout.open && focusedSurface === header && header?.isConnected) {
        focusActiveSideTab();
      }
    };
    const hosted = readRegionHostedTabs(host, active);
    const hostedTabId = hosted?.activeHostedTabId;
    if (hosted && hostedTabId && hosted.hostedTabs.some((tab) => tab.id === hostedTabId)) {
      // The focused header tab is one page, not the panel; the owner's change
      // event re-renders the strip once that page is gone.
      void hosted
        .closeHostedTab(hostedTabId)
        .then(() => host.updateComplete)
        .then(restoreFocus);
      return;
    }
    props.callbacks.closeSlot(active.slot);
    // The callback invalidates the parent first; await this region's next commit.
    refreshHostedTabs();
    void host.updateComplete.then(restoreFocus);
  };

  function Divider(view: { column: SidebarColumn }) {
    const dock = () => sidebarDock(props.layout);
    const dimension = () => (dock() === "bottom" ? "height" : "width");
    const measure = () => {
      const shell = host.parentElement;
      const primary = shell?.querySelector<HTMLElement>('[data-region="main"]');
      const panel = shell?.querySelector<HTMLElement>('[data-region="side"]:not([hidden])');
      const primarySize = primary?.getBoundingClientRect()[dimension()] ?? 0;
      const panelSize = panel?.getBoundingClientRect()[dimension()] ?? view.column[dimension()];
      // Grid columns mirror in RTL; divider ratios follow physical left/top movement.
      const panelBeforeMain =
        dock() !== "bottom" &&
        (dock() === "left") !== (getComputedStyle(shell ?? host).direction === "rtl");
      return { primarySize, panelSize, panelBeforeMain, total: primarySize + panelSize };
    };
    return (
      <resizable-divider
        class="sidebar-column__divider"
        prop:label={t("chat.sidePanel.resize")}
        prop:orientation={dock() === "bottom" ? "horizontal" : "vertical"}
        prop:splitRatio={0.5}
        prop:minRatio={0.05}
        prop:maxRatio={0.95}
        prop:measureRatio={() => {
          const { primarySize, panelSize, panelBeforeMain, total } = measure();
          return total > 0 ? (panelBeforeMain ? panelSize : primarySize) / total : 0.5;
        }}
        prop:measureSize={() => measure().total}
        onResize={(event: CustomEvent<{ splitRatio: number }>) => {
          const bounds = host.parentElement?.getBoundingClientRect();
          const regionSize =
            dimension() === "width" && props.availableWidth > 0
              ? props.availableWidth
              : (bounds?.[dimension()] ?? 0);
          const measured = measure();
          const total = measured.total || regionSize;
          const requested =
            total *
            (measured.panelBeforeMain ? event.detail.splitRatio : 1 - event.detail.splitRatio);
          const minimum = dock() === "bottom" ? SIDEBAR_MIN_HEIGHT_PX : SIDEBAR_MIN_WIDTH_PX;
          const maximum = Math.max(minimum, regionSize * 0.6);
          props.callbacks?.resizePanel(
            view.column.id,
            Math.max(minimum, Math.min(requested, maximum)),
          );
        }}
      />
    );
  }

  /**
   * A narrow pane puts the side panel in the main view's place, hiding whatever
   * held focus there. Focus continues on the panel's tab, and goes back to that
   * control once the panel is closed.
   */
  function moveFocusWithSideLock(state: {
    locked: boolean;
    managed?: boolean;
    origin?: () => HTMLElement | null;
    open: boolean;
  }): void {
    const side = host.parentElement?.querySelector<HTMLElement>(".sidebar-region__right-runtime");
    const region = host.parentElement;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inSide = Boolean(active && side?.contains(active));
    if (state.locked) {
      // The first panel a pane opens mounts this component after the browser
      // has dropped focus from the hidden view; the pane then says what held it.
      const given = state.origin?.() ?? null;
      const origin = active && region?.contains(active) && !inSide ? active : given;
      // A pane that merely loads this way has neither, and takes no focus.
      if (origin) {
        focusBeforeSideLock = origin;
        // Content with an opening focus request owns entry. Focusing its tab here
        // would look like newer input and cancel that request. Keep the return target.
        if (state.managed) {
          return;
        }
        // A tab strip rendered just now is focusable from its next frame.
        if (focusFrame !== null) {
          cancelAnimationFrame(focusFrame);
        }
        focusFrame = requestAnimationFrame(() => {
          focusFrame = null;
          const now = document.activeElement;
          const moved = now instanceof HTMLElement && now !== document.body && now !== origin;
          if (props.sideFocusLocked && !moved) {
            focusActiveSideTab();
          }
        });
      }
      return;
    }
    const before = focusBeforeSideLock;
    focusBeforeSideLock = null;
    const adrift = !active || active === document.body;
    // A panel that is still open, beside or under the main view, keeps the focus it has.
    if (!before || !(adrift || (inSide && !state.open))) {
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

  function scheduleGeometryCommit() {
    scheduleLayout(host, () => {
      const shell = host.parentElement;
      if (!host.isConnected || !shell) {
        return undefined;
      }
      const geometry = Array.from(
        shell.querySelectorAll<HTMLElement>(".sidebar-region__primary, .side-panel__panel"),
        (content) =>
          `${content.dataset.panelSlot ?? "conversation"}:${content.getBoundingClientRect().width}`,
      ).join(":");
      // The manual panel render is the commit boundary for its transcript.
      // Track content, not region roles: swapping can keep the same main/side
      // widths while changing the transcript width and its row measurements.
      return () => {
        panelElement?.dispatchEvent(
          new CustomEvent(SIDEBAR_GEOMETRY_COMMIT_EVENT, {
            bubbles: true,
            detail: {
              widthChanged: geometry !== previousGeometry,
            },
          }),
        );
        previousGeometry = geometry;
      };
    });
  }

  const panelTypes = () => props.panelDefinitions.filter((definition) => definition.available);
  function Empty(view: { panel?: SidebarPanel }) {
    const selectedType = () =>
      view.panel ? sidebarPanelType(props.panelDefinitions, view.panel.slot) : null;
    return (
      <Show
        when={selectedType()}
        fallback={
          <div class="side-panel-empty side-panel-empty--selector">
            <div class="side-panel-empty__types">
              <For each={panelTypes()} keyed={(type) => type.slot}>
                {(type) => (
                  <button
                    class="side-panel-empty__type"
                    type="button"
                    onClick={() => props.callbacks?.openSlot(type().slot)}
                  >
                    <PanelTypeOption type={type()} />
                  </button>
                )}
              </For>
            </div>
          </div>
        }
      >
        {(type) => (
          <div class="side-panel-empty side-panel-empty--type">
            <PanelEmptyState
              icon={<Icon name={type().icon} />}
              heading={type().label}
              description={type().empty.description}
              action={type().empty.action}
            />
          </div>
        )}
      </Show>
    );
  }
  function Body() {
    const panels = () =>
      props.panelDefinitions.flatMap((definition) =>
        (props.layout.columns[0]?.panels ?? []).filter(
          (panel) => panel.slot === definition.slot && panel.slot !== "conversation",
        ),
      );
    return (
      <div class="side-panel__body">
        <For each={panels()} keyed={(panel) => panel.id}>
          {(panel) => (
            <div
              id={`${props.panelIdPrefix}-${encodeURIComponent(panel().slot)}`}
              class="side-panel__panel"
              role="region"
              aria-label={sidebarPanelType(props.panelDefinitions, panel().slot).label}
              data-panel-slot={panel().slot}
              data-region={panel().id === props.layout.mainPanelId ? "main" : "side"}
              hidden={!isSidebarSlotVisible(props.layout, panel().slot)}
            >
              <SidebarPanelView
                definition={sidebarPanelType(props.panelDefinitions, panel().slot)}
                registerPanelHost={panelHostRegistration(panel().slot)}
              />
              <Show
                when={
                  !sidebarPanelType(props.panelDefinitions, panel().slot).view &&
                  sidebarPanelType(props.panelDefinitions, panel().slot).loadState === undefined &&
                  sidebarPanelType(props.panelDefinitions, panel().slot).content == null
                }
              >
                <Empty panel={panel()} />
              </Show>
            </div>
          )}
        </For>
        <Show when={sidebarSidePanels(props.layout).length === 0}>
          <div class="side-panel__empty-body" data-region="side">
            <Empty />
          </div>
        </Show>
      </div>
    );
  }
  // Keep opened content mounted while its column survives hidden presentation.
  const [mounted] = createSignal(
    (previous = false): boolean =>
      Boolean(props.layout.columns[0]) &&
      (previous ||
        (props.layout.open === true &&
          (!props.layout.expanded || props.layout.expandedSide === true)) ||
        (sidebarMainPanel(props.layout)?.slot ?? "conversation") !== "conversation"),
  );
  function Panel() {
    return (
      <Show when={props.layout.columns[0]}>
        {(column) => (
          <>
            <Show
              when={
                !props.narrow && props.layout.open && !props.layout.expanded ? column() : undefined
              }
            >
              {(value) => <Divider column={value()} />}
            </Show>
            <div class="side-panel" ref={(element) => (panelElement = element)}>
              <Show when={sidebarSidePanels(props.layout).length > 0}>
                <SidebarRegionHeader
                  {...props}
                  host={host}
                  hostedRevision={hostedRevision}
                  refreshHostedTabs={refreshHostedTabs}
                  onFocusActiveReady={(focus) => (focusActiveTab = focus)}
                />
              </Show>
              <Show when={mounted()}>
                <Body />
              </Show>
            </div>
          </>
        )}
      </Show>
    );
  }
  const listeners = new AbortController();
  const options = { capture: true, signal: listeners.signal };
  if (host.parentElement) {
    listen(host.parentElement, PANEL_HOSTED_TABS_CHANGE_EVENT, refreshHostedTabs, {
      signal: listeners.signal,
    });
  }
  listen(document, "pointerdown", trackFocus, options);
  listen(document, "focusin", trackFocus, options);
  listen(window, "openclaw:native-close-focused-panel", closeFocusedPanel, options);
  const owner = getOwner();
  let dispose: (() => void) | undefined;
  let disposed = false;
  // The pane owns this sibling outlet. Mount after the bridge commit, outside its flush.
  queueMicrotask(() => {
    const root = host.parentElement?.querySelector<HTMLElement>(".sidebar-region__right-runtime");
    if (!disposed && root) {
      dispose = render(() => <Panel />, root, undefined, { owner });
    }
  });
  // Publish committed DOM geometry to the pane's transcript layout owner.
  createEffect(
    () => [props.layout, props.panelDefinitions, hostedRevision()],
    scheduleGeometryCommit,
  );
  // Only lock transitions transfer focus; other facts are sampled then, preserving active menus.
  const focusTransition = createMemo(
    () => ({
      locked: props.sideFocusLocked,
      managed: props.sideFocusManaged,
      origin: props.sideFocusOrigin,
      open: props.layout.open === true,
    }),
    { equals: (before, after) => before.locked === after.locked },
  );
  createEffect(focusTransition, moveFocusWithSideLock);
  onCleanup(() => {
    disposed = true;
    regionOperations.delete(host);
    dispose?.();
    listeners.abort();
    focusedSurface = null;
    cancelLayout(host);
    if (focusFrame !== null) {
      cancelAnimationFrame(focusFrame);
    }
  });
  return null;
}

export const ChatSidebarRegion = defineSolidBridge<RegionProps, RegionMethods>(
  "openclaw-chat-sidebar-region",
  Region,
  {
    properties: {
      panelIdPrefix: { default: "", attribute: false },
      conversationTab: { default: undefined, attribute: false },
      layout: { default: { columns: [] }, attribute: false },
      panelDefinitions: { default: sidebarPanelDefinitions(), attribute: false },
      fetchFavicon: { default: undefined, attribute: false },
      callbacks: { default: null, attribute: false },
      narrow: { default: false },
      sideFocusLocked: { default: false },
      sideFocusManaged: { default: false },
      sideFocusOrigin: { default: undefined, attribute: false },
      availableWidth: { default: 0 },
    },
    methods: {
      readPanelHost: (host, slot) => regionOperations.get(host)?.readPanelHost(slot) ?? null,
      awaitPanelCommit: async (host, slot) => {
        await host.updateComplete;
        // The sibling outlet owns this exact recipient's commit, not the region header.
        await host.readPanelHost(slot)?.updateComplete;
      },
      activateTerminalHost: (host) => {
        const terminal = host.readPanelHost("terminal");
        if (!terminal?.isConnected || !terminal.activateTerminalHost) {
          return false;
        }
        terminal.activateTerminalHost();
        return true;
      },
      focusActiveSideTab: (host, options) =>
        regionOperations.get(host)?.focusActiveSideTab(options),
      deliverPanelEvent: (host, slot, event) => {
        const panel = host.readPanelHost(slot);
        if (!panel?.handleToggleRequest) {
          return false;
        }
        panel.handleToggleRequest(event);
        return true;
      },
    },
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-sidebar-region": RegionElement;
  }
}
