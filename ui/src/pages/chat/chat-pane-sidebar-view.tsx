import { dynamic } from "@solidjs/web";
import { For, Show, createSignal, onSettled } from "solid-js";
import { shellViewport } from "../../app/shell-viewport.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { PanelLoadingSkeleton } from "../../components/solid/panel-loading-skeleton.tsx";
import "../../styles/chat/mobile-host.css";
import { elementRef } from "../../lib/reactive/element-ref.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createScrollPosition } from "../../lib/reactive/scroll-state.ts";
import { ContentPresentation } from "../../lib/solid/presentation.ts";
import type { ElementProperties } from "../../types/solid-elements.d.ts";
import type {
  RegionProps,
  SidebarRegionViewProps,
} from "./components/chat-sidebar-region-types.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  isSidebarSlotVisible,
  sidebarDock,
  sidebarMainPanel,
} from "./sidebar-layout.ts";

export function SidebarRegionView(props: SidebarRegionViewProps) {
  let shell!: HTMLElement;
  let regionView: HTMLElementTagNameMap["openclaw-chat-sidebar-region"] | undefined;
  let detailsMount!: HTMLDivElement;
  let region!: HTMLDivElement;
  let header!: HTMLDivElement;
  let primary!: HTMLDivElement;
  let outlet!: HTMLDivElement;
  // The lazy native region mounts after this caller's refs have attached.
  const elements: NonNullable<RegionProps["elements"]> = {
    get shell() {
      return region;
    },
    get header() {
      return header;
    },
    get primary() {
      return primary;
    },
    get outlet() {
      return outlet;
    },
  };
  const mobileVisible = () => Boolean(props.mobileHost?.open && !props.mobileHost.suspended);
  const panelsVisible = () => props.mobileHost?.destination.area === "panels";
  const detailsChild = () => Boolean(props.mobileHost?.destination.page);
  const expandable = () => props.mobileHost?.destination.page?.expandable !== false;
  const resizable = () => expandable() || props.mobileHost?.destination.page?.resizable === true;
  const toggleExpanded = () =>
    props.mobileHost?.toggleExpanded(shell.getBoundingClientRect().height);
  let drag:
    | {
        pointer: number;
        y: number;
        height: number;
        current: number;
        minimum: number;
        maximum: number;
        safeTop: number;
        dock: number;
        independent: boolean;
        moved: boolean;
      }
    | undefined;
  let dragFrame = 0;
  let suppressGrabberClick = false;
  let backdropPointer: number | undefined;
  let backdropClicked = false;
  const paintResize = () => {
    dragFrame = 0;
    if (!drag) {
      return;
    }
    region.style.setProperty("--mobile-live-height", `${drag.current}px`);
    region.style.setProperty(
      "--mobile-live-reserved",
      `${drag.independent ? 0 : Math.min(drag.current, drag.dock)}px`,
    );
  };
  const clearResize = () => {
    cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    delete region.dataset.mobileDragging;
    region.style.removeProperty("--mobile-live-height");
    region.style.removeProperty("--mobile-live-reserved");
  };
  const startResize = (event: PointerEvent) => {
    if (event.button !== 0 || !resizable()) {
      return;
    }
    suppressGrabberClick = false;
    const bounds = region.getBoundingClientRect();
    const viewport = window.visualViewport;
    const minimum = 152 + (regionView?.readMobileChromeHeight?.() ?? 0);
    const safeTop =
      Number.parseFloat(getComputedStyle(region).getPropertyValue("--mobile-safe-top")) || 0;
    const maximum = Math.max(
      minimum,
      Math.min(
        bounds.height,
        viewport ? viewport.height + viewport.offsetTop - bounds.top : bounds.height,
      ) - safeTop,
    );
    const height = shell.getBoundingClientRect().height;
    drag = {
      pointer: event.pointerId,
      y: event.clientY,
      height,
      current: height,
      minimum,
      maximum,
      safeTop,
      independent: props.mobileHost?.destination.page?.presentation === "sheet",
      dock: Math.max(minimum, Math.min(bounds.height * 0.52, bounds.height - 200)),
      moved: false,
    };
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };
  const resize = (event: PointerEvent) => {
    if (!drag || drag.pointer !== event.pointerId || !resizable()) {
      return;
    }
    const delta = drag.y - event.clientY;
    if (!drag.moved && Math.abs(delta) < 4) {
      return;
    }
    drag.moved = true;
    suppressGrabberClick = true;
    region.dataset.mobileDragging = "true";
    drag.current = Math.max(drag.minimum, Math.min(drag.maximum, drag.height + delta));
    if (!dragFrame) {
      dragFrame = requestAnimationFrame(paintResize);
    }
  };
  const endResize = () => {
    const completed = drag;
    drag = undefined;
    if (!completed?.moved || !region.hasAttribute("data-mobile-dragging")) {
      return;
    }
    cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    const height =
      !completed.independent && Math.abs(completed.current - completed.dock) <= 24
        ? completed.dock
        : completed.current;
    const mode = height > completed.dock ? "expanded" : "dock";
    props.mobileHost?.resize(height, mode, mode === "expanded" ? completed.dock : 0);
    // Keep the live geometry through the owner's commit; then only the final snap animates.
    onSettled(clearResize);
  };
  onSettled(() => {
    const viewportChanged = () => {
      if (!drag?.moved) {
        return;
      }
      const bounds = region.getBoundingClientRect();
      const viewport = window.visualViewport;
      drag.maximum = Math.max(
        drag.minimum,
        Math.min(
          bounds.height,
          viewport ? viewport.height + viewport.offsetTop - bounds.top : bounds.height,
        ) - drag.safeTop,
      );
      drag.dock = Math.max(drag.minimum, Math.min(bounds.height * 0.52, bounds.height - 200));
      drag.current = Math.min(drag.current, drag.maximum);
      if (!dragFrame) {
        dragFrame = requestAnimationFrame(paintResize);
      }
    };
    const stopViewport = window.visualViewport
      ? listen(window.visualViewport, "resize", viewportChanged)
      : undefined;
    return () => {
      stopViewport?.();
      drag = undefined;
      clearResize();
    };
  });
  onSettled(() => {
    // One capture pair covers native nested scrollers without reactive work per frame.
    const scrolling = new Set<HTMLElement>();
    const start = (event: Event) => {
      if (
        props.mobileHost &&
        event.target instanceof HTMLElement &&
        !event.target.hasAttribute("data-mobile-scrolling")
      ) {
        event.target.setAttribute("data-mobile-scrolling", "");
        scrolling.add(event.target);
      }
    };
    const end = (event: Event) => {
      if (event.target instanceof HTMLElement) {
        event.target.removeAttribute("data-mobile-scrolling");
        scrolling.delete(event.target);
      }
    };
    const stopScroll = listen(shell, "scroll", start, { capture: true, passive: true });
    const stopScrollEnd = listen(shell, "scrollend", end, { capture: true, passive: true });
    return () => {
      stopScroll();
      stopScrollEnd();
      for (const element of scrolling) {
        element.removeAttribute("data-mobile-scrolling");
      }
      scrolling.clear();
    };
  });
  const ScrollFades = () => {
    onSettled(() => props.mobileScrollFades?.connect(shell));
    return undefined;
  };
  onSettled(() =>
    shellViewport.subscribe(() => props.mobileHost?.onViewportChange(shellViewport.snapshot)),
  );
  const column = () => props.layout.columns[0];
  const visiblePanels = () =>
    column()?.panels.filter(
      (panel) => panel.slot !== "conversation" && isSidebarSlotVisible(props.layout, panel.slot),
    ) ?? [];
  // Match the layout owner's visibility contract, including an empty launcher.
  const sideVisible = () =>
    props.layout.open === true && (!props.layout.expanded || props.layout.expandedSide === true);
  const chatMain = () =>
    !sidebarMainPanel(props.layout) || sidebarMainPanel(props.layout)?.slot === "conversation";
  const collapsed = () =>
    props.narrow ||
    (props.availableWidth > 0 && props.availableWidth < SIDEBAR_NARROW_BREAKPOINT_PX);
  return (
    <div
      ref={[(element) => (region = element), elementRef(props.onRegionElementRef)]}
      data-mobile-open={props.mobileHost && mobileVisible() ? "" : undefined}
      class={[
        "sidebar-region",
        `sidebar-region--${sidebarDock(props.layout)}`,
        {
          "sidebar-region--background": Boolean(props.background),
          "sidebar-region--narrow": collapsed(),
          "sidebar-region--expanded": props.layout.expanded,
          "sidebar-region--expanded-side": props.layout.expanded && props.layout.expandedSide,
          "sidebar-region--open": props.layout.open === true,
          "sidebar-region--mobile-host": Boolean(props.mobileHost),
          "sidebar-region--desktop": props.presentation === "desktop",
          "sidebar-region--external-toggle": props.externalPanelsToggle === true,
          "sidebar-region--side-visible": sideVisible(),
        },
      ]}
      style={{
        "--side-panel-width": `${column()?.width ?? 480}px`,
        "--side-panel-height": `${column()?.height ?? 360}px`,
        "--mobile-dock-height":
          props.mobileHost?.mode !== "dock" || props.mobileHost.height === undefined
            ? undefined
            : `${props.mobileHost.height}px`,
        "--mobile-sheet-height":
          props.mobileHost?.destination.page?.presentation === "sheet" &&
          props.mobileHost.height !== undefined
            ? `${props.mobileHost.height}px`
            : undefined,
        "--mobile-expanded-height":
          props.mobileHost?.mode !== "expanded" || props.mobileHost.height === undefined
            ? undefined
            : `${props.mobileHost.height}px`,
        "--mobile-min-height": panelsVisible()
          ? `calc(152px + var(--rail-header-height, 40px) + ${props.mobileHost?.destination.backTo ? 36 : 0}px)`
          : "152px",
        "--mobile-reserved-height":
          !mobileVisible() || props.mobileHost?.destination.page?.presentation === "sheet"
            ? "0px"
            : props.mobileHost?.mode === "expanded"
              ? `${props.mobileHost.reservedHeight}px`
              : "var(--mobile-dock-size)",
      }}
    >
      <Show when={props.background}>
        <div
          class="sidebar-region__background"
          hidden={!isSidebarSlotVisible(props.layout, "conversation")}
          style={{
            "grid-area": chatMain()
              ? "main-header / main-header / main / main"
              : "side-header / side-header / side / side",
          }}
        >
          {props.background}
        </div>
      </Show>
      <div
        class="sidebar-region__header"
        tabindex={-1}
        ref={[(element) => (header = element), elementRef(props.onHeaderElementRef)]}
        inert={
          props.presentation === "desktop" &&
          props.layout.expanded === true &&
          props.layout.expandedSide === true
        }
      >
        {props.header}
      </div>
      <Show when={props.externalPanelsToggle}>
        <div class="sidebar-region__panels-toggle">
          <openclaw-tooltip prop:content={t("chat.sessionHeader.panels")}>
            <button
              type="button"
              class="btn btn--ghost btn--icon chat-icon-btn chat-pane__panels-toggle"
              aria-label={t("chat.sessionHeader.panels")}
              aria-expanded={sideVisible() ? "true" : "false"}
              onClick={() => props.callbacks.setOpen(!sideVisible())}
            >
              <Icon name={sideVisible() ? "sessionPanelsActive" : "sessionPanels"} />
            </button>
          </openclaw-tooltip>
        </div>
      </Show>
      <Show when={props.regionError === undefined}>
        <openclaw-chat-sidebar-region
          ref={[
            elementRef(props.onRegionViewRef),
            elementRef((element) => {
              regionView = element;
              return () => {
                regionView = undefined;
              };
            }),
          ]}
          prop:elements={elements}
          prop:panelIdPrefix={props.panelIdPrefix}
          prop:mobileHost={props.mobileHost}
          prop:onScrollPortRef={props.mobileScrollFades?.register}
          prop:presentation={props.presentation}
          prop:conversationTab={props.conversationTab}
          prop:layout={props.layout}
          prop:fetchFavicon={props.fetchFavicon}
          prop:panelDefinitions={props.panelDefinitions}
          prop:callbacks={props.callbacks}
          prop:narrow={props.narrow}
          prop:sideFocusLocked={props.sideFocusLocked === true}
          prop:sideFocusManaged={props.sideFocusManaged === true}
          prop:sideFocusOrigin={props.sideFocusOrigin}
          prop:availableWidth={props.availableWidth}
        />
      </Show>
      <div
        id={`${props.panelIdPrefix}-conversation`}
        class="sidebar-region__primary"
        ref={(element) => (primary = element)}
        role="region"
        aria-label={t("chat.sidePanel.conversation")}
        data-region={chatMain() ? "main" : "side"}
        hidden={!isSidebarSlotVisible(props.layout, "conversation")}
        inert={!isSidebarSlotVisible(props.layout, "conversation")}
      >
        {props.primary}
      </div>
      <Show
        when={
          props.mobileHost &&
          mobileVisible() &&
          (props.mobileHost.mode === "expanded" ||
            props.mobileHost.destination.page?.presentation === "sheet")
        }
      >
        <div
          class="chat-mobile-host__backdrop"
          aria-hidden="true"
          onPointerDown={(event) => {
            backdropPointer = event.pointerId;
            backdropClicked = false;
          }}
          onPointerUp={(event) => {
            backdropClicked = backdropPointer === event.pointerId;
            backdropPointer = undefined;
          }}
          onPointerCancel={() => {
            backdropPointer = undefined;
            backdropClicked = false;
          }}
          onPointerLeave={() => {
            backdropPointer = undefined;
            backdropClicked = false;
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (backdropClicked) {
              props.mobileHost?.close();
            }
            backdropClicked = false;
          }}
        />
      </Show>
      <section
        ref={(element) => (shell = element)}
        class="chat-mobile-host"
        data-mode={props.mobileHost?.mode}
        data-presentation={props.mobileHost?.destination.page?.presentation}
        data-mobile-page={props.mobileHost?.destination.page?.key}
        hidden={Boolean(props.mobileHost) && !mobileVisible()}
        inert={Boolean(props.mobileHost) && !mobileVisible()}
        aria-label={props.mobileHost ? t("chat.sessionHeader.panels") : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented && props.mobileHost) {
            event.preventDefault();
            props.mobileHost.close();
          }
        }}
        onFocusIn={(event) => {
          const target = event.target;
          if (
            props.mobileHost?.mode === "dock" &&
            target instanceof HTMLElement &&
            (target.matches(
              "textarea:not([readonly]):not([disabled]), input:not([readonly]):not([disabled]):not([type=button]):not([type=submit]):not([type=reset]):not([type=color]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file])",
            ) ||
              target.isContentEditable)
          ) {
            toggleExpanded();
          }
        }}
      >
        <Show when={props.mobileHost}>
          <ScrollFades />
          <Show when={resizable()}>
            <button
              class="chat-mobile-host__grabber"
              type="button"
              aria-label={
                !expandable()
                  ? t("board.widget.resizeHandle", {
                      title: props.mobileHost?.destination.page?.title ?? "",
                    })
                  : props.mobileHost?.mode === "expanded"
                    ? t("common.restore")
                    : t("chat.sidePanel.expandPanel", { panel: t("chat.sidePanel.label") })
              }
              onPointerDown={startResize}
              onPointerMove={resize}
              onPointerUp={endResize}
              onLostPointerCapture={endResize}
              onPointerCancel={() => {
                clearResize();
                drag = undefined;
              }}
              onClick={(event) => {
                if (expandable() && (event.detail === 0 || !suppressGrabberClick)) {
                  toggleExpanded();
                }
                suppressGrabberClick = false;
                drag = undefined;
              }}
            >
              <span />
            </button>
          </Show>
          <header class="chat-mobile-host__header">
            <button
              type="button"
              class="chat-mobile-host__circle"
              aria-label={
                detailsChild() && props.mobileHost?.destination.backTo
                  ? t("common.back")
                  : t("common.close")
              }
              onClick={() =>
                detailsChild() && props.mobileHost?.destination.backTo
                  ? props.mobileHost.back()
                  : props.mobileHost?.close()
              }
            >
              <Icon
                name={detailsChild() && props.mobileHost?.destination.backTo ? "chevronLeft" : "x"}
              />
            </button>
            <Show
              when={detailsChild() ? props.mobileHost?.destination.page : undefined}
              fallback={
                <div class="chat-mobile-host__segments">
                  <button
                    type="button"
                    aria-pressed={
                      props.mobileHost?.destination.area === "details" ? "true" : "false"
                    }
                    onClick={() => props.mobileHost?.navigate({ area: "details" })}
                  >
                    {t("chat.sessionDetails.title")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={
                      props.mobileHost?.destination.area === "panels" ? "true" : "false"
                    }
                    onClick={() => props.mobileHost?.navigate({ area: "panels" })}
                  >
                    {t("chat.sessionHeader.panels")}
                  </button>
                </div>
              }
            >
              {(page) => {
                const Heading = dynamic(() => page().heading ?? (() => page().title));
                return (
                  <div
                    class="chat-mobile-host__title"
                    data-details-route={page().details?.kind}
                    title={page().details?.kind === "pull-request" ? page().title : undefined}
                  >
                    <Heading />
                  </div>
                );
              }}
            </Show>
            {props.mobileHost?.destination.page?.headerActions}
            <Show when={expandable()}>
              <button
                type="button"
                class="chat-mobile-host__circle"
                aria-label={
                  props.mobileHost?.mode === "expanded"
                    ? t("common.restore")
                    : t("chat.sidePanel.expandPanel", { panel: t("chat.sidePanel.label") })
                }
                onClick={toggleExpanded}
              >
                <Icon
                  name={
                    props.mobileHost?.mode === "expanded"
                      ? "sessionPanelRestore"
                      : "sessionPanelExpand"
                  }
                />
              </button>
            </Show>
            <Show when={detailsChild() && props.mobileHost?.destination.backTo}>
              <button
                type="button"
                class="chat-mobile-host__circle"
                aria-label={t("common.close")}
                onClick={() => props.mobileHost?.close()}
              >
                <Icon name="x" />
              </button>
            </Show>
          </header>
        </Show>
        <Show when={props.mobileHost?.setDetailsMount} keyed>
          {(attach) => {
            onSettled(() => {
              attach(detailsMount);
              return () => attach(null);
            });
            return undefined;
          }}
        </Show>
        <div
          class="chat-mobile-host__details"
          ref={(element) => (detailsMount = element)}
          hidden={
            !props.mobileHost ||
            props.mobileHost.destination.area !== "details" ||
            Boolean(props.mobileHost.destination.page && !props.mobileHost.destination.page.details)
          }
        />
        <Show
          when={
            detailsChild() && !props.mobileHost?.destination.page?.details
              ? props.mobileHost?.destination.page
              : undefined
          }
        >
          {(page) => {
            const Page = dynamic(() => page().render ?? (() => page().content));
            const [scrollport, setScrollport] = createSignal<HTMLDivElement>();
            createScrollPosition(() => ({
              restore: {
                identity: [page().key, scrollport()],
                target: scrollport(),
                top: 0,
              },
            }));
            return (
              <ContentPresentation value={mobileVisible}>
                <div
                  class="chat-mobile-host__page"
                  data-mobile-page={page().key}
                  ref={[setScrollport, elementRef(props.mobileScrollFades?.register)]}
                >
                  <Page />
                </div>
              </ContentPresentation>
            );
          }}
        </Show>
        <div
          class="chat-mobile-host__panels"
          hidden={Boolean(props.mobileHost) && (!panelsVisible() || detailsChild())}
          inert={Boolean(props.mobileHost) && (!panelsVisible() || detailsChild())}
        >
          <Show when={props.regionError === null}>
            <For each={visiblePanels()} keyed={(panel) => panel.id}>
              {(panel) => (
                <div
                  class="side-panel__panel"
                  data-region={panel().id === props.layout.mainPanelId ? "main" : "side"}
                >
                  <PanelLoadingSkeleton
                    {...props.panelDefinitions.find(
                      (definition) => definition.slot === panel().slot,
                    )!.loading}
                  />
                </div>
              )}
            </For>
          </Show>
          <Show
            when={props.regionError != null}
            fallback={
              <div class="sidebar-region__right-runtime" ref={(element) => (outlet = element)} />
            }
          >
            <div class="sidebar-region__right-runtime" ref={(element) => (outlet = element)}>
              <For each={visiblePanels()} keyed={(panel) => panel.id}>
                {(panel) => {
                  const label = () =>
                    props.panelDefinitions.find((definition) => definition.slot === panel().slot)!
                      .label;
                  return (
                    <section
                      class="side-panel__panel sidebar-region__failed-panel"
                      data-region={panel().id === props.layout.mainPanelId ? "main" : "side"}
                    >
                      {/* Shell chrome cannot depend on the region module that failed to load. */}
                      <header class="rail-header">
                        <strong>{label()}</strong>
                        <button
                          class="rail-header__action"
                          type="button"
                          aria-label={t("chat.sidebarColumns.close", {
                            panel: label(),
                          })}
                          onClick={() => props.callbacks.closeSlot(panel().slot)}
                        >
                          <Icon name="x" />
                        </button>
                      </header>
                      <LazyViewError {...props.regionError!} />
                    </section>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </section>
    </div>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-sidebar-region": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-chat-sidebar-region"]
      > &
        ElementProperties<RegionProps>;
    }
  }
}
