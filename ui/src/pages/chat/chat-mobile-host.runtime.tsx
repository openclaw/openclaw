import { dynamic } from "@solidjs/web";
import { Show, createSignal, onSettled } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { createTextOverflow } from "../../components/solid/text-overflow.ts";
import { elementRef } from "../../lib/reactive/element-ref.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createScrollPosition } from "../../lib/reactive/scroll-state.ts";
import { ContentPresentation } from "../../lib/solid/presentation.ts";
import { createMobileSheetScrollFadeConnection } from "./chat-mobile-scroll-fades.runtime.ts";
import type { SidebarRegionViewProps } from "./components/chat-sidebar-region-types.ts";

type MobileHostViewProps = { view: SidebarRegionViewProps };

export function MobileHostBackdrop(props: MobileHostViewProps) {
  let backdropPointer: number | undefined;
  let backdropClicked = false;
  const mobileVisible = () =>
    Boolean(props.view.mobileHost?.open && !props.view.mobileHost.suspended);
  return (
    <Show
      when={
        props.view.mobileHost &&
        mobileVisible() &&
        (props.view.mobileHost.mode === "expanded" ||
          props.view.mobileHost.destination.page?.presentation === "sheet")
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
            props.view.mobileHost?.close();
          }
          backdropClicked = false;
        }}
      />
    </Show>
  );
}

export function MobileHostChrome(
  props: MobileHostViewProps & {
    readRegion: () => HTMLDivElement;
    readShell: () => HTMLElement;
    readRegionView: () => HTMLElementTagNameMap["openclaw-chat-sidebar-region"] | undefined;
  },
) {
  const detailsChild = () => Boolean(props.view.mobileHost?.destination.page);
  const expandable = () => props.view.mobileHost?.destination.page?.expandable !== false;
  const resizable = () =>
    expandable() || props.view.mobileHost?.destination.page?.resizable === true;
  const toggleExpanded = () =>
    props.view.mobileHost?.toggleExpanded(props.readShell().getBoundingClientRect().height);
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
  const paintResize = () => {
    dragFrame = 0;
    if (!drag) {
      return;
    }
    props.readRegion().style.setProperty("--mobile-live-height", `${drag.current}px`);
    props
      .readRegion()
      .style.setProperty(
        "--mobile-live-reserved",
        `${drag.independent ? 0 : Math.min(drag.current, drag.dock)}px`,
      );
  };
  const clearResize = () => {
    cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    delete props.readRegion().dataset.mobileDragging;
    props.readRegion().style.removeProperty("--mobile-live-height");
    props.readRegion().style.removeProperty("--mobile-live-reserved");
  };
  const startResize = (event: PointerEvent) => {
    if (event.button !== 0 || !resizable()) {
      return;
    }
    suppressGrabberClick = false;
    const bounds = props.readRegion().getBoundingClientRect();
    const viewport = window.visualViewport;
    const minimum = 152 + (props.readRegionView()?.readMobileChromeHeight?.() ?? 0);
    const safeTop =
      Number.parseFloat(
        getComputedStyle(props.readRegion()).getPropertyValue("--mobile-safe-top"),
      ) || 0;
    const maximum = Math.max(
      minimum,
      Math.min(
        bounds.height,
        viewport ? viewport.height + viewport.offsetTop - bounds.top : bounds.height,
      ) - safeTop,
    );
    const height = props.readShell().getBoundingClientRect().height;
    drag = {
      pointer: event.pointerId,
      y: event.clientY,
      height,
      current: height,
      minimum,
      maximum,
      safeTop,
      independent: props.view.mobileHost?.destination.page?.presentation === "sheet",
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
    props.readRegion().dataset.mobileDragging = "true";
    drag.current = Math.max(drag.minimum, Math.min(drag.maximum, drag.height + delta));
    if (!dragFrame) {
      dragFrame = requestAnimationFrame(paintResize);
    }
  };
  const endResize = () => {
    const completed = drag;
    drag = undefined;
    if (!completed?.moved || !props.readRegion().hasAttribute("data-mobile-dragging")) {
      return;
    }
    cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    const height =
      !completed.independent && Math.abs(completed.current - completed.dock) <= 24
        ? completed.dock
        : completed.current;
    const mode = height > completed.dock ? "expanded" : "dock";
    props.view.mobileHost?.resize(height, mode, mode === "expanded" ? completed.dock : 0);
    // Keep the live geometry through the owner's commit; then only the final snap animates.
    onSettled(clearResize);
  };
  onSettled(() => {
    const viewportChanged = () => {
      if (!drag?.moved) {
        return;
      }
      const bounds = props.readRegion().getBoundingClientRect();
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
        props.view.mobileHost &&
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
    const stopScroll = listen(props.readShell(), "scroll", start, { capture: true, passive: true });
    const stopScrollEnd = listen(props.readShell(), "scrollend", end, {
      capture: true,
      passive: true,
    });
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
    onSettled(() =>
      props.view.mobileScrollFades?.connect((ports) =>
        createMobileSheetScrollFadeConnection(ports, props.readShell()),
      ),
    );
    return undefined;
  };
  return (
    <Show when={props.view.mobileHost}>
      <ScrollFades />
      <Show when={resizable()}>
        <button
          class="chat-mobile-host__grabber"
          type="button"
          aria-label={
            !expandable()
              ? t("board.widget.resizeHandle", {
                  title: props.view.mobileHost?.destination.page?.title ?? "",
                })
              : props.view.mobileHost?.mode === "expanded"
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
            detailsChild() && props.view.mobileHost?.destination.backTo
              ? t("common.back")
              : t("common.close")
          }
          onClick={() =>
            detailsChild() && props.view.mobileHost?.destination.backTo
              ? props.view.mobileHost.back()
              : props.view.mobileHost?.close()
          }
        >
          <Icon
            name={detailsChild() && props.view.mobileHost?.destination.backTo ? "chevronLeft" : "x"}
          />
        </button>
        <Show
          when={detailsChild() ? props.view.mobileHost?.destination.page : undefined}
          fallback={
            <div class="chat-mobile-host__segments">
              <button
                type="button"
                aria-pressed={
                  props.view.mobileHost?.destination.area === "details" ? "true" : "false"
                }
                onClick={() => props.view.mobileHost?.navigate({ area: "details" })}
              >
                {t("chat.sessionDetails.title")}
              </button>
              <button
                type="button"
                aria-pressed={
                  props.view.mobileHost?.destination.area === "panels" ? "true" : "false"
                }
                onClick={() => props.view.mobileHost?.navigate({ area: "panels" })}
              >
                {t("chat.sessionHeader.panels")}
              </button>
            </div>
          }
        >
          {(page) => {
            const Heading = dynamic(() => page().heading ?? (() => page().title));
            return (
              <Show
                when={page().details?.kind === "pull-request"}
                fallback={
                  <div
                    ref={createTextOverflow(() => page().title)}
                    class="chat-mobile-host__title"
                    data-details-route={page().details?.kind}
                  >
                    <Heading />
                  </div>
                }
              >
                <div
                  class="chat-mobile-host__title"
                  data-details-route="pull-request"
                  title={page().title}
                >
                  <Heading />
                </div>
              </Show>
            );
          }}
        </Show>
        {props.view.mobileHost?.destination.page?.headerActions}
        <Show when={expandable()}>
          <button
            type="button"
            class="chat-mobile-host__circle"
            aria-label={
              props.view.mobileHost?.mode === "expanded"
                ? t("common.restore")
                : t("chat.sidePanel.expandPanel", { panel: t("chat.sidePanel.label") })
            }
            onClick={toggleExpanded}
          >
            <Icon
              name={
                props.view.mobileHost?.mode === "expanded"
                  ? "sessionPanelRestore"
                  : "sessionPanelExpand"
              }
            />
          </button>
        </Show>
        <Show when={detailsChild() && props.view.mobileHost?.destination.backTo}>
          <button
            type="button"
            class="chat-mobile-host__circle"
            aria-label={t("common.close")}
            onClick={() => props.view.mobileHost?.close()}
          >
            <Icon name="x" />
          </button>
        </Show>
      </header>
    </Show>
  );
}

export function MobileHostPage(props: MobileHostViewProps) {
  const detailsChild = () => Boolean(props.view.mobileHost?.destination.page);
  const mobileVisible = () =>
    Boolean(props.view.mobileHost?.open && !props.view.mobileHost.suspended);
  return (
    <Show
      when={
        detailsChild() && !props.view.mobileHost?.destination.page?.details
          ? props.view.mobileHost?.destination.page
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
              ref={[setScrollport, elementRef(props.view.mobileScrollFades?.register)]}
            >
              <Page />
            </div>
          </ContentPresentation>
        );
      }}
    </Show>
  );
}
