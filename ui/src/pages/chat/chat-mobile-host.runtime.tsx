import { dynamic } from "@solidjs/web";
import { Show, createSignal, onSettled } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { createTextOverflow } from "../../components/solid/text-overflow.ts";
import { createVelocityTracker, rubberBand } from "../../lib/motion/gesture.ts";
import { SHEET_SPRING, springEasing } from "../../lib/motion/spring.ts";
import { elementRef } from "../../lib/reactive/element-ref.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createScrollPosition } from "../../lib/reactive/scroll-state.ts";
import { ContentPresentation } from "../../lib/solid/presentation.ts";
import { resolveMobileSheetRelease } from "./chat-mobile-host-release.ts";
import { createMobileSheetScrollFadeConnection } from "./chat-mobile-scroll-fades.runtime.ts";
import type { SidebarRegionViewProps } from "./components/chat-sidebar-region-types.ts";

type MobileHostViewProps = { view: SidebarRegionViewProps };

/** The expand control's height: min(85%, 100% − max(24px, safe top)) in mobile-host.css. */
function expandedDetent(bounds: number, safeTop: number, maximum: number): number {
  return Math.min(maximum, bounds * 0.85, bounds - Math.max(24, safeTop));
}

const MOBILE_HEADER_CONTROLS =
  "button, a, input, select, textarea, [role='button'], [contenteditable]";

export function MobileHostBackdrop(props: MobileHostViewProps) {
  let backdropPointer: number | undefined;
  let backdropClicked = false;
  const mobileVisible = () =>
    Boolean(props.view.mobileHost?.open && !props.view.mobileHost.suspended);
  return (
    <Show when={props.view.mobileHost}>
      {/* Stays mounted while hidden so dimming fades out with the sheet. */}
      <div
        class="chat-mobile-host__backdrop"
        aria-hidden="true"
        hidden={
          !mobileVisible() ||
          (props.view.mobileHost?.mode !== "expanded" &&
            props.view.mobileHost?.destination.page?.presentation !== "sheet")
        }
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
        /** Finger-following height before clamping; below minimum the sheet slides down. */
        current: number;
        minimum: number;
        maximum: number;
        safeTop: number;
        dock: number;
        expanded: number;
        bounds: number;
        independent: boolean;
        moved: boolean;
        velocity: ReturnType<typeof createVelocityTracker>;
      }
    | undefined;
  let dragFrame = 0;
  let releaseTimer = 0;
  let suppressGrabberClick = false;
  // Layout height never drops below the minimum: the sheet translates instead, so its
  // content does not reflow. Past the maximum the drag rubber-bands like a scroll view.
  const dragGeometry = (state: NonNullable<typeof drag>) => {
    const height =
      state.current > state.maximum
        ? Math.min(
            state.bounds,
            state.maximum + rubberBand(state.current - state.maximum, state.bounds),
          )
        : Math.max(state.minimum, state.current);
    const offset = Math.max(0, state.minimum - state.current);
    return { height, offset, visible: Math.max(0, height - offset) };
  };
  const paintResize = () => {
    dragFrame = 0;
    if (!drag) {
      return;
    }
    const { height, offset } = dragGeometry(drag);
    // Sheet geometry stays on the sheet so the conversation does not restyle per frame.
    props.readShell().style.setProperty("--mobile-live-height", `${height}px`);
    props
      .readShell()
      .style.setProperty("--mobile-live-translate", offset > 0 ? `0 ${offset}px` : "none");
    props
      .readRegion()
      .style.setProperty(
        "--mobile-live-reserved",
        `${drag.independent ? 0 : Math.max(0, Math.min(height, drag.dock) - offset)}px`,
      );
  };
  const clearResize = (keepHeight = false) => {
    cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    delete props.readRegion().dataset.mobileDragging;
    props.readRegion().style.removeProperty("--mobile-live-reserved");
    props.readShell().style.removeProperty("--mobile-live-translate");
    if (!keepHeight) {
      props.readShell().style.removeProperty("--mobile-live-height");
    }
  };
  const settleRelease = () => {
    clearTimeout(releaseTimer);
    releaseTimer = 0;
    props.readRegion().style.removeProperty("--motion-sheet");
    props.readRegion().style.removeProperty("--motion-sheet-duration");
  };
  /** Plays the next geometry change as a spring that starts at the finger's speed. */
  const playRelease = (velocity: number) => {
    settleRelease();
    const { easing, durationMs } = springEasing(
      SHEET_SPRING,
      Math.max(-20, Math.min(20, velocity)),
    );
    // Every sheet transition in the region reads these tokens, so one override retimes them.
    props.readRegion().style.setProperty("--motion-sheet", `${durationMs}ms ${easing}`);
    props.readRegion().style.setProperty("--motion-sheet-duration", `${durationMs}ms`);
    releaseTimer = window.setTimeout(() => {
      settleRelease();
      // A dismissed sheet keeps its released height until it has left the screen.
      if (!drag) {
        props.readShell().style.removeProperty("--mobile-live-height");
      }
    }, durationMs + 50);
  };
  const startResize = (event: PointerEvent) => {
    if (event.button !== 0 || !resizable()) {
      return;
    }
    settleRelease();
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
    const velocity = createVelocityTracker();
    velocity.add(event.timeStamp, -event.clientY);
    drag = {
      pointer: event.pointerId,
      y: event.clientY,
      height,
      current: height,
      minimum,
      maximum,
      safeTop,
      bounds: bounds.height,
      independent: props.view.mobileHost?.destination.page?.presentation === "sheet",
      dock: Math.max(minimum, Math.min(bounds.height * 0.52, bounds.height - 200)),
      expanded: expandedDetent(bounds.height, safeTop, maximum),
      moved: false,
      velocity,
    };
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };
  const resize = (event: PointerEvent) => {
    if (!drag || drag.pointer !== event.pointerId || !resizable()) {
      return;
    }
    drag.velocity.add(event.timeStamp, -event.clientY);
    const delta = drag.y - event.clientY;
    if (!drag.moved && Math.abs(delta) < 4) {
      return;
    }
    drag.moved = true;
    suppressGrabberClick = true;
    props.readRegion().dataset.mobileDragging = "true";
    drag.current = Math.max(0, drag.height + delta);
    if (!dragFrame) {
      dragFrame = requestAnimationFrame(paintResize);
    }
  };
  const endResize = (event: PointerEvent) => {
    const completed = drag;
    drag = undefined;
    if (!completed?.moved || !props.readRegion().hasAttribute("data-mobile-dragging")) {
      return;
    }
    cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    // Re-enable transitions now; the live geometry still pins the sheet in place, so the
    // owner's commit below is the change that animates.
    delete props.readRegion().dataset.mobileDragging;
    const velocity = completed.velocity.velocity(event.timeStamp);
    const release = resolveMobileSheetRelease(
      {
        height: completed.current,
        start: completed.height,
        minimum: completed.minimum,
        maximum: completed.maximum,
        dock: completed.dock,
        expanded: completed.expanded,
        independent: completed.independent,
      },
      velocity,
    );
    const visible = dragGeometry(completed).visible;
    if (release.kind === "close") {
      playRelease(visible > 0 ? -velocity / visible : 0);
      props.view.mobileHost?.close();
      onSettled(() => clearResize(true));
      return;
    }
    const distance = release.height - visible;
    playRelease(Math.abs(distance) > 1 ? velocity / distance : 0);
    props.view.mobileHost?.resize(
      release.height,
      release.mode,
      release.mode === "expanded" ? completed.dock : 0,
    );
    // Keep the live geometry through the owner's commit; then only the final snap animates.
    onSettled(() => clearResize());
  };
  const cancelResize = () => {
    clearResize();
    drag = undefined;
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
      drag.bounds = bounds.height;
      drag.dock = Math.max(drag.minimum, Math.min(bounds.height * 0.52, bounds.height - 200));
      drag.expanded = expandedDetent(bounds.height, drag.safeTop, drag.maximum);
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
      settleRelease();
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
          onPointerCancel={cancelResize}
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
      <header
        class="chat-mobile-host__header"
        onPointerDown={(event) => {
          // Like a sheet's navigation bar, empty header space drags; controls keep their taps.
          if (event.target instanceof Element && !event.target.closest(MOBILE_HEADER_CONTROLS)) {
            startResize(event);
          }
        }}
        onPointerMove={resize}
        onPointerUp={endResize}
        onLostPointerCapture={endResize}
        onPointerCancel={cancelResize}
      >
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
