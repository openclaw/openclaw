import type { JSX as SolidJSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { PanelLoadingSkeleton } from "../../components/solid/panel-loading-skeleton.tsx";
import { elementRef } from "../../lib/reactive/element-ref.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ElementProperties } from "../../types/solid-elements.d.ts";
import type {
  RegionProps,
  SidebarPanelDefinition,
  SidebarRegionCallbacks,
} from "./components/chat-sidebar-region-types.ts";
import type { LinkFaviconFetcher } from "./link-favicon-cache.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  isSidebarSlotVisible,
  sidebarDock,
  sidebarMainPanel,
  type SidebarLayout,
} from "./sidebar-layout.ts";

export type SidebarRegionParams = {
  onRegionElementRef?: (element: HTMLElement) => void | (() => void);
  onHeaderElementRef?: (element: HTMLElement) => void | (() => void);
  onRegionViewRef?: (
    element: HTMLElementTagNameMap["openclaw-chat-sidebar-region"],
  ) => void | (() => void);
  presentationId: string;
  conversationTab?: RegionProps["conversationTab"];
  fetchFavicon?: LinkFaviconFetcher;
  availableWidth: number;
  callbacks: SidebarRegionCallbacks;
  layout: SidebarLayout;
  narrow: boolean;
  /** A narrow pane's presentation can differ from the saved layout. */
  sideFocusLocked?: boolean;
  sideFocusManaged?: boolean;
  sideFocusOrigin?: () => HTMLElement | null;
  panelDefinitions?: SidebarPanelDefinition[];
  header?: SolidJSX.Element;
  background?: SolidJSX.Element;
  primary?: SolidJSX.Element;
};

export type SidebarRegionViewProps = SidebarRegionParams & {
  panelIdPrefix: string;
  panelDefinitions: SidebarPanelDefinition[];
  regionError: Parameters<typeof LazyViewError>[0] | null | undefined;
};

export function SidebarRegionView(props: SidebarRegionViewProps) {
  let shell!: HTMLDivElement;
  let header!: HTMLDivElement;
  let primary!: HTMLDivElement;
  let outlet!: HTMLDivElement;
  // The lazy native region mounts after this caller's refs have attached.
  const elements: NonNullable<RegionProps["elements"]> = {
    get shell() {
      return shell;
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
  const column = () => props.layout.columns[0];
  const visiblePanels = () =>
    column()?.panels.filter(
      (panel) => panel.slot !== "conversation" && isSidebarSlotVisible(props.layout, panel.slot),
    ) ?? [];
  const chatMain = () =>
    !sidebarMainPanel(props.layout) || sidebarMainPanel(props.layout)?.slot === "conversation";
  const collapsed = () =>
    props.narrow ||
    (props.availableWidth > 0 && props.availableWidth < SIDEBAR_NARROW_BREAKPOINT_PX);
  return (
    <div
      ref={[(element) => (shell = element), elementRef(props.onRegionElementRef)]}
      class={[
        "sidebar-region",
        `sidebar-region--${sidebarDock(props.layout)}`,
        {
          "sidebar-region--background": Boolean(props.background),
          "sidebar-region--narrow": collapsed(),
          "sidebar-region--expanded": props.layout.expanded,
          "sidebar-region--expanded-side": props.layout.expanded && props.layout.expandedSide,
          "sidebar-region--open": props.layout.open === true,
        },
      ]}
      style={{
        "--side-panel-width": `${column()?.width ?? 480}px`,
        "--side-panel-height": `${column()?.height ?? 360}px`,
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
      >
        {props.header}
      </div>
      <Show
        when={props.regionError === undefined}
        fallback={
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
        }
      >
        <openclaw-chat-sidebar-region
          ref={[elementRef(props.onRegionViewRef)]}
          prop:elements={elements}
          prop:panelIdPrefix={props.panelIdPrefix}
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
      >
        {props.primary}
      </div>
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
