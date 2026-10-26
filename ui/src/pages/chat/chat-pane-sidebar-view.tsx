import { Portal } from "@solidjs/web";
import { Errored, For, Loading, Show, createMemo, lazy, onSettled, type Element } from "solid-js";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { PanelLoadingSkeleton } from "../../components/solid/panel-loading-skeleton.tsx";
import "../../styles/chat/mobile-host.css";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { elementRef } from "../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
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

registerEnglishCatalog(registerChatSessionEnglish);

const MobileHostBackdrop = lazy(() => import("./chat-mobile-host.runtime.tsx"), {
  export: "MobileHostBackdrop",
});
const MobileHostChrome = lazy(() => import("./chat-mobile-host.runtime.tsx"), {
  export: "MobileHostChrome",
});
const MobileHostPage = lazy(() => import("./chat-mobile-host.runtime.tsx"), {
  export: "MobileHostPage",
});

const ChatSidebarRegion = lazy(() => import("./components/chat-sidebar-region.runtime.tsx"), {
  export: "ChatSidebarRegion",
});

function MobileHostBoundary(props: { children: Element; fallback?: Element }) {
  return (
    <Errored
      fallback={(error, reset) => (
        <LazyViewError
          error={error()}
          stale={isStaleChunkImportError(error())}
          onRetry={() => {
            if (isStaleChunkImportError(error())) {
              void retryStaleChunkReloadWhenReachable();
            } else {
              reset();
            }
          }}
          inline
        />
      )}
    >
      <Loading fallback={props.fallback}>{props.children}</Loading>
    </Errored>
  );
}

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
  const mobileActivated = createMemo<boolean>(
    (previous) => previous === true || Boolean(props.mobileHost),
  );
  const mobileVisible = () => Boolean(props.mobileHost?.open && !props.mobileHost.suspended);
  const panelsVisible = () => props.mobileHost?.destination.area === "panels";
  const detailsChild = () => Boolean(props.mobileHost?.destination.page);
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
  function RegionPlaceholder(status: { error?: unknown; retry?: () => void }) {
    return (
      <Portal mount={outlet}>
        <For each={visiblePanels()} keyed={(panel) => panel.id}>
          {(panel) => {
            const definition = () =>
              props.panelDefinitions.find((entry) => entry.slot === panel().slot)!;
            return (
              <section
                class={[
                  "side-panel__panel",
                  { "sidebar-region__failed-panel": Boolean(status.retry) },
                ]}
                data-region={panel().id === props.layout.mainPanelId ? "main" : "side"}
              >
                <Show
                  when={status.retry}
                  fallback={<PanelLoadingSkeleton {...definition().loading} />}
                >
                  <header class="rail-header">
                    <strong>{definition().label}</strong>
                    <button
                      class="rail-header__action"
                      type="button"
                      aria-label={t("chat.sidebarColumns.close", { panel: definition().label })}
                      onClick={() => props.callbacks.closeSlot(panel().slot)}
                    >
                      <Icon name="x" />
                    </button>
                  </header>
                  <LazyViewError
                    error={status.error}
                    stale={isStaleChunkImportError(status.error)}
                    onRetry={() => status.retry?.()}
                  />
                </Show>
              </section>
            );
          }}
        </For>
      </Portal>
    );
  }
  function RegionRuntime() {
    // Refs belong to the conditional region, outside Loading's tracked children.
    const regionRefs = [
      elementRef((element: HTMLElementTagNameMap["openclaw-chat-sidebar-region"]) =>
        props.onRegionViewRef?.(element),
      ),
      elementRef((element: HTMLElementTagNameMap["openclaw-chat-sidebar-region"]) => {
        regionView = element;
        return () => {
          regionView = undefined;
        };
      }),
    ];
    return (
      <Errored
        fallback={(error) => (
          <RegionPlaceholder
            error={error()}
            retry={() => void retryStaleChunkReloadWhenReachable()}
          />
        )}
      >
        <Loading fallback={<RegionPlaceholder />}>
          <ChatSidebarRegion
            ref={regionRefs}
            elements={elements}
            panelIdPrefix={props.panelIdPrefix}
            mobileHost={props.mobileHost}
            onScrollPortRef={props.mobileScrollFades?.register}
            presentation={props.presentation}
            conversationTab={props.conversationTab}
            layout={props.layout}
            fetchFavicon={props.fetchFavicon}
            panelDefinitions={props.panelDefinitions}
            callbacks={props.callbacks}
            narrow={props.narrow}
            sideFocusLocked={props.sideFocusLocked === true}
            sideFocusManaged={props.sideFocusManaged === true}
            sideFocusOrigin={props.sideFocusOrigin}
            availableWidth={props.availableWidth}
            onPanelReady={props.onPanelReady}
          />
        </Loading>
      </Errored>
    );
  }
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
      <Show when={mobileActivated()}>
        <MobileHostBoundary>
          <MobileHostBackdrop view={props} />
        </MobileHostBoundary>
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
          // Keep delegated ordering: an open menu consumes Escape before its host closes.
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
            props.mobileHost.toggleExpanded(shell.getBoundingClientRect().height);
          }
        }}
      >
        <Show when={mobileActivated()}>
          <MobileHostBoundary
            fallback={
              <Show when={props.mobileHost}>
                <Show
                  when={
                    props.mobileHost?.destination.page?.expandable !== false ||
                    props.mobileHost?.destination.page?.resizable === true
                  }
                >
                  <div class="chat-mobile-host__grabber" aria-hidden="true" />
                </Show>
                <div class="chat-mobile-host__header" aria-hidden="true" />
              </Show>
            }
          >
            <MobileHostChrome
              view={props}
              readRegion={() => region}
              readShell={() => shell}
              readRegionView={() => regionView}
            />
          </MobileHostBoundary>
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
        <Show when={mobileActivated()}>
          <MobileHostBoundary>
            <MobileHostPage view={props} />
          </MobileHostBoundary>
        </Show>
        <div
          class="chat-mobile-host__panels"
          hidden={Boolean(props.mobileHost) && (!panelsVisible() || detailsChild())}
          inert={Boolean(props.mobileHost) && (!panelsVisible() || detailsChild())}
        >
          <div class="sidebar-region__right-runtime" ref={(element) => (outlet = element)} />
        </div>
      </section>
      <Show when={props.layout.columns.length > 0}>
        <RegionRuntime />
      </Show>
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
