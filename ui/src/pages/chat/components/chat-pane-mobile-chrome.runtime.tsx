import { createMemo, lazy, Loading, Show, type Element } from "solid-js";
import { isSessionTitlePending } from "../../../lib/session-display.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import type { ChatPaneHeaderProps } from "./chat-pane-header.types.ts";
import { ChatPaneMobileHeader } from "./chat-pane-mobile-header.tsx";
import "./chat-pane-mobile-composition.css";

const ChatMobilePeopleGrid = lazy(() => import("./chat-mobile-people-grid.tsx"), {
  export: "ChatMobilePeopleGrid",
});

export function ChatPaneMobileChrome(props: {
  header: ChatPaneHeaderProps;
  project?: Element;
  details: Element;
  notice: Element;
  sessionMenu: Element;
  mobile: boolean;
  presented: boolean;
  incognito: boolean;
  compactActions: boolean;
  deviceOffline: boolean | undefined;
  machineName: string | undefined;
  peopleControls: string;
  peopleLabel: string;
  morePeople: (count: number) => string;
  peopleExpanded: boolean;
  onChromeRef: (element: HTMLDivElement) => void;
  onOpenPeople: (source: HTMLElement) => void;
  onOpenMachine: (source: HTMLElement) => void;
}) {
  const host = () => props.header.detailsControl?.mobileHost;
  // A desktop-first pane defers People; an adopted trigger survives desktop parking.
  const mobileActivated = createMemo<boolean>((previous) => previous === true || props.mobile);
  return (
    <ContentPresentation value={() => props.presented}>
      <div
        ref={(element) => {
          props.onChromeRef(element);
        }}
        hidden={!props.mobile}
        inert={!props.presented}
        aria-hidden={props.mobile ? undefined : "true"}
        style={{ display: props.mobile ? "contents" : "none" }}
      >
        <ChatPaneMobileHeader
          active={props.mobile}
          onHeaderRef={props.header.onHeaderRef}
          title={props.header.title}
          titlePending={
            props.header.titlePending ??
            (!props.header.catalog &&
              isSessionTitlePending(props.header.session?.key ?? "", props.header.session))
          }
          project={props.project}
          publicAccess={props.header.publicAccessIndicator}
          incognito={props.incognito}
          navDrawerOpen={props.header.navDrawerOpen ?? false}
          onOpenDetails={(source) => props.header.onOpenDetails?.(source)}
          onOpenPanels={(source) => host()?.reveal(source)}
          panelsOpen={Boolean(host()?.open && !host()?.suspended)}
          compactActions={props.compactActions}
          onOpenDashboard={props.header.onOpenDashboard}
          notice={
            props.header.gatewayStatus?.kind && props.header.gatewayStatus.kind !== "connected"
              ? {
                  kind: "gateway",
                  status: props.header.gatewayStatus.kind,
                  onRetry: props.header.gatewayStatus.onRetry,
                }
              : props.deviceOffline && props.machineName
                ? {
                    kind: "device-offline",
                    deviceName: props.machineName!,
                    onOpenMachine: props.onOpenMachine,
                  }
                : undefined
          }
          people={
            <Show
              when={
                mobileActivated() && !props.incognito && props.header.mobilePeople?.header.length
              }
            >
              <Loading>
                <ChatMobilePeopleGrid
                  people={props.header.mobilePeople!}
                  label={props.peopleLabel}
                  morePeople={props.morePeople}
                  controls={props.peopleControls}
                  expanded={props.peopleExpanded}
                  onOpen={props.onOpenPeople}
                />
              </Loading>
            </Show>
          }
          actions={<Show when={props.mobile}>{props.sessionMenu}</Show>}
        />
        <Show when={props.mobile}>{props.details}</Show>
        <Show when={props.mobile}>{props.notice}</Show>
      </div>
    </ContentPresentation>
  );
}
