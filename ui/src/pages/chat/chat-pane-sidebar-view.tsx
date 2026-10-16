import type { JSX as SolidJSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { PanelLoadingSkeleton } from "../../components/solid/panel-loading-skeleton.tsx";
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
  requestUpdate: () => void;
};

export type SidebarRegionViewProps = SidebarRegionParams & {
  panelIdPrefix: string;
  panelDefinitions: SidebarPanelDefinition[];
  regionError: Parameters<typeof LazyViewError>[0] | null | undefined;
};

export function SidebarRegionView(props: SidebarRegionViewProps) {
  const column = () => props.layout.columns[0];
  const chatMain = () =>
    !sidebarMainPanel(props.layout) || sidebarMainPanel(props.layout)?.slot === "conversation";
  const collapsed = () =>
    props.narrow ||
    (props.availableWidth > 0 && props.availableWidth < SIDEBAR_NARROW_BREAKPOINT_PX);
  return (
    <div
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
      <div class="sidebar-region__header">{props.header}</div>
      <Show
        when={props.regionError === undefined}
        fallback={
          <Show when={props.regionError === null}>
            <For
              each={
                column()?.panels.filter(
                  (panel) =>
                    panel.slot !== "conversation" && isSidebarSlotVisible(props.layout, panel.slot),
                ) ?? []
              }
              keyed={(panel) => panel.id}
            >
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
        role="region"
        aria-label={t("chat.sidePanel.conversation")}
        data-region={chatMain() ? "main" : "side"}
        hidden={!isSidebarSlotVisible(props.layout, "conversation")}
      >
        {props.primary}
      </div>
      <Show
        when={props.regionError != null}
        fallback={<div class="sidebar-region__right-runtime" />}
      >
        <div class="sidebar-region__right-runtime">
          <LazyViewError {...props.regionError!} />
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
