import "../../../styles/chat/side-panel.css";
import { Portal } from "@solidjs/web";
import { For, Show, createSignal, onSettled } from "solid-js";
import { registryFor } from "../../../components/overlay-registry.ts";
import { PANEL_HOSTED_TABS_CHANGE_EVENT } from "../../../components/panel-hosted-tabs.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  LINK_READER_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../../../components/panel-toggle-contract.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { cancelLayout, scheduleLayout } from "../../../lib/layout-frame.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { defineSolidBridge } from "../../../lib/solid-bridge.ts";
import { createTabFocus } from "../../../lib/tabs.ts";
import { sidebarPanelDefinitions } from "../chat-pane-embedded-panels.ts";
import { SidebarPanel as SidebarPanelView } from "../chat-pane-embedded-view.tsx";
import {
  SIDEBAR_GEOMETRY_COMMIT_EVENT,
  isSidebarNewTabActive,
  sidebarMainPanel,
  sidebarSidePanels,
  sidebarActivePanel,
  isSidebarSlotVisible,
  type SidebarPanel,
  type SidebarSlotId,
} from "../sidebar-layout.ts";
import { MobilePanelLauncher } from "./chat-panel-launcher-mobile.tsx";
import { SidebarRegionDivider } from "./chat-sidebar-region-divider.tsx";
import {
  SidebarRegionHeader,
  closeEmptyMobileHost,
  PanelTypeOption,
  SidebarPanelLauncher,
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
  Pick<RegionMethods, "readPanelHost" | "focusActiveSideTab" | "readMobileChromeHeight"> & {
    inputsChanged(key: keyof RegionProps): void;
  }
>();

function Region(props: RegionProps, host: RegionElement) {
  const panelHosts = new Map<SidebarSlotId, SidebarPanelHost>();
  const panelElements = new Map<string, HTMLDivElement>();
  const panelRef = (id: string) =>
    elementRef((element: HTMLDivElement) => {
      panelElements.set(id, element);
      return () => panelElements.delete(id);
    });
  let sideHeader: HTMLElement | null = null;
  let localBack: HTMLElement | undefined;
  const tabFocus = createTabFocus();
  const operations = {
    readMobileChromeHeight: () =>
      (props.mobileHost?.destination.area === "panels"
        ? (sideHeader?.getBoundingClientRect().height ?? 0)
        : 0) + (localBack?.getBoundingClientRect().height ?? 0),
    readPanelHost: (slot: SidebarSlotId) =>
      panelHosts.get(slot) ??
      props.panelDefinitions.find((definition) => definition.slot === slot)?.panelHost ??
      null,
    focusActiveSideTab: tabFocus.focusActive,
    inputsChanged(key: keyof RegionProps) {
      if (key === "elements") {
        bindHostedTabsRoot();
      }
      if (key === "elements" || key === "layout" || key === "panelDefinitions") {
        scheduleGeometryCommit();
      }
      if (key === "elements" || key === "sideFocusLocked") {
        scheduleFocusTransition();
      }
    },
  };
  regionOperations.set(host, operations);
  let panelElement: HTMLDivElement | undefined;
  let previousGeometry = "";
  let focusFrame: number | null = null;
  let focusedSurface: Element | null = null;
  let focusBeforeSideLock: HTMLElement | null = null;
  // Child panels publish hosted tabs synchronously while their parent commits.
  const [hostedRevision, setHostedRevision] = createSignal(0, { ownedWrite: true });
  const refreshHostedTabs = () => {
    setHostedRevision((value) => value + 1);
    scheduleGeometryCommit();
  };
  function notifyPanelReady() {
    if (!props.onPanelReady) {
      return;
    }
    // Direct Solid hosts can settle before their portal inserts them.
    queueMicrotask(() =>
      onSettled(() => {
        if (regionOperations.get(host) === operations && host.isConnected) {
          props.onPanelReady?.();
        }
      }),
    );
  }
  const panelHostRegistration = (initialSlot: SidebarSlotId) => (element: SidebarPanelHost) => {
    panelHosts.set(initialSlot, element);
    refreshHostedTabs();
    notifyPanelReady();
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
      surface && surface.closest(".sidebar-region") === props.elements?.shell ? surface : null;
  };

  const closeFocusedPanel = async (event: Event): Promise<void> => {
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
    const browserHost = host.readPanelHost("browser");
    const browser =
      typeof browserScope === "string" && browserHost?.dataset.nativeBrowserScope === browserScope
        ? browserHost
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
    const provisional = isSidebarNewTabActive(props.layout);
    if (
      (!active && !provisional) ||
      (props.presentation === "desktop" && active?.slot === "conversation") ||
      !surface?.isConnected ||
      surface.closest(".sidebar-region") !== props.elements?.shell ||
      !surface.matches('[data-region="side"], [data-region-header="side"]') ||
      surface.closest('[hidden], [inert], [aria-hidden="true"]') ||
      document.openClawModalLayers?.size ||
      [...registryFor(document).members.keys()].some(
        ({ surface: modal }) =>
          modal instanceof HTMLDialogElement && modal.open && modal.isConnected,
      )
    ) {
      return;
    }
    event.preventDefault();
    // Keep successive Close commands in the tab strip after its content unmounts.
    const header = sideHeader ?? null;
    focusedSurface = header;
    const restoreFocus = () => {
      if (props.layout.open && focusedSurface === header && header?.isConnected) {
        tabFocus.focusActive();
      }
    };
    const scope = props.panelIdPrefix;
    const mobileScope = props.mobileHost?.scopeKey;
    const isCurrentClose = () =>
      host.isConnected &&
      props.panelIdPrefix === scope &&
      props.mobileHost?.scopeKey === mobileScope;
    const finishClose = async () => {
      await host.updateComplete;
      if (isCurrentClose() && !closeEmptyMobileHost(props, mobileScope)) {
        restoreFocus();
      }
    };
    if (provisional) {
      props.callbacks.newTab?.close();
      await finishClose();
      return;
    }
    if (!active) {
      return;
    }
    const hosted = readRegionHostedTabs(host, active);
    const hostedTabId = hosted?.activeHostedTabId;
    if (hosted && hostedTabId && hosted.hostedTabs.some((tab) => tab.id === hostedTabId)) {
      // The focused header tab is one page, not the panel; the owner's change
      // event re-renders the strip once that page is gone.
      await hosted.closeHostedTab(hostedTabId);
      await host.updateComplete;
      if (
        (props.presentation === "desktop" || props.mobileHost) &&
        isCurrentClose() &&
        sidebarActivePanel(props.layout)?.id === active.id &&
        readRegionHostedTabs(host, active) === hosted &&
        hosted.hostedTabs.length === 0
      ) {
        props.callbacks?.closeSlot(active.slot);
        refreshHostedTabs();
      }
      await finishClose();
      return;
    }
    if (props.presentation === "desktop" && active.slot === "companion") {
      const clear = props.panelDefinitions.find((definition) => definition.slot === "companion")
        ?.view?.onClearCompanion;
      if (
        !clear ||
        !(await clear()) ||
        !host.isConnected ||
        props.panelIdPrefix !== scope ||
        sidebarActivePanel(props.layout)?.id !== active.id ||
        !props.layout.open ||
        !props.callbacks
      ) {
        return;
      }
    }
    props.callbacks.closeSlot(active.slot);
    // The callback invalidates the parent first; await this region's next commit.
    refreshHostedTabs();
    await finishClose();
  };

  function scheduleGeometryCommit() {
    scheduleLayout(host, () => {
      const elements = props.elements;
      if (!host.isConnected || !elements) {
        return undefined;
      }
      const geometry = [
        elements.primary,
        ...(props.layout.columns[0]?.panels.flatMap((panel) => {
          const element = panelElements.get(panel.id);
          return element ? [element] : [];
        }) ?? []),
      ]
        .map(
          (content) =>
            `${content.dataset.panelSlot ?? "conversation"}:${content.getBoundingClientRect().width}`,
        )
        .join(":");
      // The panel commit is the geometry boundary for its transcript.
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

  const openPanelFromLauncher = (slot: SidebarSlotId) => {
    const alreadyOpen = props.layout.columns[0]?.panels.some((panel) => panel.slot === slot);
    if (props.callbacks?.newTab) {
      props.callbacks.newTab.openPanel(slot);
    } else {
      props.callbacks?.openSlot(slot);
    }
    if (!alreadyOpen) {
      return;
    }
    const request =
      slot === "browser"
        ? ([BROWSER_PANEL_TOGGLE_EVENT, { open: true, newTab: true }] as const)
        : slot === "link-reader"
          ? ([LINK_READER_PANEL_TOGGLE_EVENT, { open: true, newTab: true }] as const)
          : slot === "terminal"
            ? ([TERMINAL_PANEL_TOGGLE_EVENT, { open: true, newSession: true }] as const)
            : undefined;
    if (request) {
      host.deliverPanelEvent(slot, new CustomEvent(request[0], { detail: request[1] }));
    }
  };
  const hasNativeFileBack = () => {
    hostedRevision();
    const active = sidebarActivePanel(props.layout);
    if (active?.slot !== "workspace") {
      return false;
    }
    const selected = readRegionHostedTabs(host, active)?.activeHostedTabId;
    return Boolean(selected && selected !== "browse");
  };
  const openMobileLauncher = () =>
    props.callbacks?.newTab?.open({ returnPanelId: props.layout.columns[0]?.activePanelId });
  const panelTypes = () => props.panelDefinitions.filter((definition) => definition.available);
  function Empty(view: { panel?: SidebarPanel }) {
    const selectedType = () =>
      view.panel ? sidebarPanelType(props.panelDefinitions, view.panel.slot) : null;
    return (
      <Show
        when={selectedType()}
        fallback={
          <Show
            when={props.presentation === "desktop"}
            fallback={
              <Show
                when={props.mobileHost}
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
                <MobilePanelLauncher
                  definitions={props.panelDefinitions}
                  onOpen={openPanelFromLauncher}
                  onScrollPortRef={props.onScrollPortRef}
                />
              </Show>
            }
          >
            <SidebarPanelLauncher
              definitions={props.panelDefinitions}
              onOpen={openPanelFromLauncher}
            />
          </Show>
        }
      >
        {(type) => (
          <PanelEmptyState
            presentation={props.presentation}
            icon={<Icon name={type().icon} />}
            heading={type().label}
            description={type().empty.description}
            action={type().empty.action}
          />
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
      <div
        class="side-panel__body"
        hidden={Boolean(props.mobileHost?.destination.page)}
        inert={Boolean(props.mobileHost?.destination.page)}
      >
        <For each={panels()} keyed={(panel) => panel.id}>
          {(panel) => {
            return (
              <div
                ref={[panelRef(panel().id)]}
                id={`${props.panelIdPrefix}-${encodeURIComponent(panel().slot)}`}
                class="side-panel__panel"
                role="region"
                aria-label={sidebarPanelType(props.panelDefinitions, panel().slot).label}
                data-panel-slot={panel().slot}
                data-region={panel().id === props.layout.mainPanelId ? "main" : "side"}
                hidden={!isSidebarSlotVisible(props.layout, panel().slot)}
                inert={!isSidebarSlotVisible(props.layout, panel().slot)}
              >
                <SidebarPanelView
                  definition={sidebarPanelType(props.panelDefinitions, panel().slot)}
                  visible={isSidebarSlotVisible(props.layout, panel().slot)}
                  registerPanelHost={panelHostRegistration(panel().slot)}
                />
                <Show
                  when={
                    !sidebarPanelType(props.panelDefinitions, panel().slot).view &&
                    sidebarPanelType(props.panelDefinitions, panel().slot).content == null
                  }
                >
                  <Empty panel={panel()} />
                </Show>
              </div>
            );
          }}
        </For>
        <Show
          when={sidebarSidePanels(props.layout).length === 0 || isSidebarNewTabActive(props.layout)}
        >
          <div
            class="side-panel__empty-body"
            data-region="side"
            id={
              props.mobileHost && isSidebarNewTabActive(props.layout)
                ? `${props.panelIdPrefix}-new-tab`
                : undefined
            }
          >
            <Show
              when={!props.mobileHost && isSidebarNewTabActive(props.layout)}
              fallback={<Empty />}
            >
              <SidebarPanelLauncher
                definitions={props.panelDefinitions}
                onOpen={openPanelFromLauncher}
              />
            </Show>
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
                !props.mobileHost &&
                props.layout.open &&
                (props.presentation === "desktop" || (!props.narrow && !props.layout.expanded))
                  ? column()
                  : undefined
              }
            >
              {(value) => (
                <SidebarRegionDivider
                  elements={props.elements}
                  layout={props.layout}
                  availableWidth={props.availableWidth}
                  callbacks={props.callbacks}
                  column={value()}
                  panelElements={panelElements}
                  host={host}
                />
              )}
            </Show>
            <div class="side-panel" ref={(element) => (panelElement = element)}>
              <Show
                when={
                  props.presentation === "desktop" ||
                  Boolean(props.mobileHost) ||
                  sidebarSidePanels(props.layout).length > 0
                }
              >
                <SidebarRegionHeader
                  {...props}
                  host={host}
                  onOpenMobileLauncher={props.mobileHost ? openMobileLauncher : undefined}
                  hostedRevision={hostedRevision}
                  refreshHostedTabs={refreshHostedTabs}
                  headerRef={(element) => (sideHeader = element)}
                  tabFocus={tabFocus}
                />
              </Show>
              <Show
                when={
                  props.mobileHost?.destination.area === "panels" &&
                  props.mobileHost.destination.backTo &&
                  !hasNativeFileBack() &&
                  props.mobileHost.destination.slot !== "dashboard"
                }
              >
                <div
                  class="chat-mobile-host__local-back"
                  ref={[
                    elementRef((element) => {
                      localBack = element;
                      return () => {
                        localBack = undefined;
                      };
                    }),
                  ]}
                >
                  <button type="button" onClick={() => props.mobileHost?.back()}>
                    <Icon name="chevronLeft" />
                    {t("common.back")}
                  </button>
                  <span>{props.mobileHost?.destination.page?.title}</span>
                </div>
              </Show>
              <Show when={mounted()}>
                <Body />
              </Show>
              <Show
                when={
                  props.mobileHost?.destination.area === "panels"
                    ? props.mobileHost.destination.page
                    : undefined
                }
              >
                {(page) => (
                  <div
                    class="chat-mobile-host__page"
                    data-region="side"
                    ref={[elementRef(props.onScrollPortRef)]}
                  >
                    {page().content}
                  </div>
                )}
              </Show>
            </div>
          </>
        )}
      </Show>
    );
  }
  let previousLock: boolean | undefined;
  let focusQueued = false;
  function scheduleFocusTransition() {
    if (focusQueued) {
      return;
    }
    focusQueued = true;
    onSettled(() => {
      focusQueued = false;
      if (regionOperations.get(host) !== operations || previousLock === props.sideFocusLocked) {
        return;
      }
      previousLock = props.sideFocusLocked;
      /**
       * A narrow pane puts the side panel in the main view's place, hiding whatever
       * held focus there. Focus continues on the panel's tab, and goes back to that
       * control once the panel is closed.
       */
      const transitionLocked = props.sideFocusLocked;
      const transitionManaged = props.sideFocusManaged;
      const transitionOrigin = props.sideFocusOrigin;
      const transitionOpen = props.layout.open === true;
      const side = props.elements?.outlet;
      const region = props.elements?.shell;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const inSide = Boolean(active && side?.contains(active));
      if (transitionLocked) {
        // The first panel a pane opens mounts this component after the browser
        // has dropped focus from the hidden view; the pane then says what held it.
        const given = transitionOrigin?.() ?? null;
        const origin = active && region?.contains(active) && !inSide ? active : given;
        // A pane that merely loads this way has neither, and takes no focus.
        if (origin) {
          focusBeforeSideLock = origin;
          // Content with an opening focus request owns entry. Focusing its tab here
          // would look like newer input and cancel that request. Keep the return target.
          if (transitionManaged) {
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
              tabFocus.focusActive();
            }
          });
        }
        return;
      }
      const before = focusBeforeSideLock;
      focusBeforeSideLock = null;
      const adrift = !active || active === document.body;
      // A panel that is still open, beside or under the main view, keeps the focus it has.
      if (!before || !(adrift || (inSide && !transitionOpen))) {
        return;
      }
      before.focus({ preventScroll: true });
      if (document.activeElement !== before) {
        // That control is gone by now; carry on from the main view's own header.
        props.elements?.header.focus({ preventScroll: true });
      }
    });
  }
  const listeners = new AbortController();
  const options = { capture: true, signal: listeners.signal };
  let stopHostedTabs = () => {};
  function bindHostedTabsRoot() {
    stopHostedTabs();
    const shell = host.elements?.shell;
    if (!shell) {
      stopHostedTabs = () => {};
      return;
    }
    const onTransition = (event: TransitionEvent) => {
      if (
        props.presentation === "desktop" &&
        event.target instanceof HTMLElement &&
        (event.target === shell || event.target.matches("[data-region], [data-region-header]")) &&
        event.target.closest(".sidebar-region") === shell
      ) {
        scheduleGeometryCommit();
      }
    };
    const stops = [
      listen(shell, PANEL_HOSTED_TABS_CHANGE_EVENT, refreshHostedTabs),
      listen(shell, "transitionend", onTransition),
      listen(shell, "transitioncancel", onTransition),
    ];
    stopHostedTabs = () => stops.forEach((stop) => stop());
  }
  // Descendants can publish hosted tabs synchronously during their first commit.
  bindHostedTabsRoot();
  listen(document, "pointerdown", trackFocus, options);
  listen(document, "focusin", trackFocus, options);
  listen(
    window,
    "openclaw:native-close-focused-panel",
    (event) => {
      void closeFocusedPanel(event);
    },
    options,
  );
  onSettled(() => {
    scheduleGeometryCommit();
    scheduleFocusTransition();
    notifyPanelReady();
    return () => {
      regionOperations.delete(host);
      stopHostedTabs();
      listeners.abort();
      focusedSurface = null;
      cancelLayout(host);
      if (focusFrame !== null) {
        cancelAnimationFrame(focusFrame);
      }
    };
  });
  return (
    <Show when={props.elements}>
      {(elements) => (
        <Portal mount={elements().outlet}>
          <Panel />
        </Portal>
      )}
    </Show>
  );
}

export const ChatSidebarRegion = defineSolidBridge<RegionProps, RegionMethods>(
  "openclaw-chat-sidebar-region",
  Region,
  {
    properties: {
      elements: { default: null, attribute: false },
      mobileHost: { default: undefined, attribute: false },
      onScrollPortRef: { default: undefined, attribute: false },
      presentation: { default: undefined, attribute: false },
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
      onPanelReady: { default: undefined, attribute: false },
    },
    methods: {
      readMobileChromeHeight: (host) => regionOperations.get(host)?.readMobileChromeHeight() ?? 0,
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
    propertyChanged: (host, key) => regionOperations.get(host)?.inputsChanged(key),
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-sidebar-region": RegionElement;
  }
}
