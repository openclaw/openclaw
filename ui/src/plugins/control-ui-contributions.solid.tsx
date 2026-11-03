import { Show, lazy, onSettled } from "solid-js";
import type {
  ControlUiAccessoryProps,
  ControlUiSessionHeaderFacts,
} from "../../../src/plugin-sdk/control-ui.js";
import type { SidebarMenus } from "../components/sidebar-menus.tsx";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { sharedPluginsProjection } from "../lib/reactive/shared-application-projections.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { ControlUiLazyView } from "./control-ui-lazy-view.tsx";

export type ContributionsProps = {
  facts: ControlUiSessionHeaderFacts | undefined;
  artifact: unknown;
  worktreeId: string | undefined;
  onContentChange: ControlUiAccessoryProps["onContentChange"];
  onPresenceChange: ControlUiAccessoryProps["onPresenceChange"];
  registerControls: ControlUiAccessoryProps["registerControls"];
  detailsPage: { pluginId: string; id: string } | undefined;
  onOpenDetailsPage:
    | ((pluginId: string, page: { id: string; title: string }, source?: HTMLElement) => void)
    | undefined;
  onDetailsBack: (() => void) | undefined;
  compact: boolean;
  dismissed: boolean;
  onOpenSessionDiff: (() => void) | undefined;
  kind:
    | "navigation"
    | "session-header"
    | "session-context"
    | "session-environment"
    | "session-row"
    | "session-hovercard"
    | "session-activity"
    | "session-summary"
    | "session-mobile-root"
    | "session-mobile-page"
    | "session-mobile-activity"
    | "composer"
    | "header";
  sessionKey: string;
  agentId: string | undefined;
  navigationKey: string;
  navigationChildren: boolean;
  navigationMenus: SidebarMenus | undefined;
  presented: boolean;
};
export type ContributionsElement = SolidBridgeElement<ContributionsProps>;

const Content = lazy(() => import("./control-ui-contributions-content.tsx"), {
  export: "PluginContributionsContent",
});

function PluginContributionsContent(props: ContributionsProps, host: ContributionsElement) {
  const context = useOptionalApplication();
  host.style.display = "contents";
  const source = context && sharedPluginsProjection(context.plugins);
  // Presence only schedules the optional renderer; its owner still admits every registration.
  const available = () => {
    const runtime = source?.read();
    const family =
      props.kind === "navigation"
        ? "navigation"
        : props.kind === "header" || props.kind === "composer"
          ? "actions"
          : "accessories";
    return family === "accessories"
      ? runtime
          ?.registrations("accessories")
          .some((entry) => "mount" in entry.value && entry.value.placement === props.kind) === true
      : (runtime?.registrations(family).length ?? 0) > 0;
  };
  onSettled(() => {
    if (!available()) {
      props.onPresenceChange?.(false);
    }
  });
  return (
    <Show when={available()}>
      <ControlUiLazyView>
        <Content properties={props} host={host} />
      </ControlUiLazyView>
    </Show>
  );
}

export const PluginContributions = defineSolidBridge<ContributionsProps>(
  "openclaw-plugin-contributions",
  PluginContributionsContent,
  {
    properties: {
      facts: { default: undefined, attribute: false },
      artifact: { default: undefined, attribute: false },
      worktreeId: { default: undefined, attribute: false },
      onContentChange: { default: undefined, attribute: false },
      onPresenceChange: { default: undefined, attribute: false },
      registerControls: { default: undefined, attribute: false },
      detailsPage: { default: undefined, attribute: false },
      onOpenDetailsPage: { default: undefined, attribute: false },
      onDetailsBack: { default: undefined, attribute: false },
      compact: { default: false, attribute: false },
      dismissed: { default: false, attribute: false },
      onOpenSessionDiff: { default: undefined, attribute: false },
      kind: { default: "navigation", attribute: false },
      sessionKey: { default: "", attribute: false },
      agentId: { default: undefined, attribute: false },
      navigationKey: { default: "", attribute: false },
      navigationChildren: { default: true, type: Boolean },
      navigationMenus: { default: undefined, attribute: false },
      presented: { default: true, type: Boolean },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-contributions": ContributionsElement;
  }
}
