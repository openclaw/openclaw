import { dynamic, type JSX as SolidJSX } from "@solidjs/web";
import { Match, Show, Switch } from "solid-js";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import { isBrowserPanelAvailable } from "../../app/panel-availability.ts";
import { EMPTY_LINK_READERS } from "../../components/link-reader-target.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { PanelLoadingSkeleton } from "../../components/solid/panel-loading-skeleton.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { ElementProperties } from "../../types/solid-elements.d.ts";
import type { SidebarPanelDefinitionParams, SidebarPanelData } from "./chat-pane-embedded-types.ts";
import { EmbeddedPluginPanel } from "./chat-pane-plugin-panel.tsx";
import { usePanePresentation } from "./chat-pane-presentation.ts";
import { ChatBoardPanel } from "./chat-pane-surfaces.tsx";
import { resolveChatAttachmentLimits } from "./components/chat-attachment-admission.ts";
import { ChatDetailSlot } from "./components/chat-detail-slot-view.tsx";
import { SessionWorkspaceRail } from "./components/chat-session-workspace-rail-solid.tsx";
import {
  closeSessionWorkspacePreview,
  selectSessionWorkspacePreview,
} from "./components/chat-session-workspace-state.ts";
import type { SessionWorkspaceState } from "./components/chat-session-workspace-types.ts";
import type { SidebarContent } from "./components/chat-sidebar-content-types.ts";
import type { SidebarPanelDefinition } from "./components/chat-sidebar-region-types.ts";
import type { SidebarSlotId } from "./sidebar-layout-types.ts";
import { sidebarMainPanel } from "./sidebar-layout.ts";

type Props = SidebarPanelDefinitionParams;

function TerminalPanel(props: Props) {
  return (
    <openclaw-terminal-panel
      data-sidebar-panel-host
      prop:embedded={true}
      prop:tabsInHeader={props.terminalTabsInHeader}
      prop:onClose={props.onCloseTerminal}
      prop:client={props.state.client}
      prop:gatewayConnected={props.state.connected}
      prop:available={props.state.terminalAvailable}
      prop:agentId={props.agentId}
      prop:sessionKey={props.state.sessionKey}
      prop:themeMode={props.themeMode}
      prop:basePath={props.state.basePath}
    />
  );
}

function BrowserPanel(props: Props) {
  const presented = usePanePresentation(() => props.browserPresented);
  return (
    <openclaw-browser-panel
      data-sidebar-panel-host
      prop:embedded={true}
      data-chat-autotype-exempt
      prop:client={props.state.connected ? props.state.client : null}
      prop:available={props.state.browserPanelAvailable}
      prop:remoteAvailable={isBrowserPanelAvailable({
        phase: props.state.connected ? "connected" : "offline",
        hello: props.state.hello,
      })}
      prop:presented={presented()}
      prop:tabsInHeader={props.browserTabsInHeader}
      prop:refreshOnPresentation={props.browserRefreshOnPresentation}
      prop:sessionKey={props.state.sessionKey}
      prop:preferredTab={props.preferredBrowserTab}
      prop:sessionTabs={props.sessionBrowserTabs ?? []}
      prop:resourceBasePath={props.state.resourceBasePath}
      prop:authToken={resolveControlUiAuthToken(props.state)}
    />
  );
}

function CompanionPanel(props: Props) {
  const presented = usePanePresentation(() => props.companionPresented);
  return (
    <openclaw-chat-session-rail
      data-sidebar-panel-host
      prop:presented={presented()}
      prop:focusRequest={props.companionFocusRequest}
      prop:sessionKey={props.state.sessionKey}
      prop:digest={props.digest}
      prop:running={Boolean(props.activeRunId)}
      prop:activeRunId={props.activeRunId}
      prop:pullRequests={props.pullRequests}
      prop:companion={props.companion}
      prop:connected={props.state.connected}
      prop:sendShortcut={props.state.settings.chatSendShortcut ?? "enter"}
      prop:onSubmit={props.onCompanionSubmit}
      prop:onDraftChange={props.onCompanionDraftChange}
      prop:onAttachmentsChange={props.onCompanionAttachmentsChange}
      prop:uploadConfig={props.state.uploadConfig}
      prop:attachmentLimits={resolveChatAttachmentLimits(props.state.hello?.policy)}
    />
  );
}

function DesktopPanel(props: Props) {
  const presented = usePanePresentation(() => props.desktopPresented);
  return (
    <openclaw-desktop-panel
      data-sidebar-panel-host
      prop:embedded={true}
      data-chat-autotype-exempt
      prop:client={props.state.connected ? props.state.client : null}
      prop:available={props.desktopAvailable}
      prop:presented={presented()}
      prop:refreshOnPresentation={props.desktopRefreshOnPresentation}
      prop:requestedSource={props.desktopSource}
      prop:sessionKey={props.state.sessionKey}
      prop:onFocusTargetChange={props.onDesktopFocusTargetChange}
    />
  );
}

function DiscussionPanel(props: Props) {
  return (
    <openclaw-session-discussion
      data-sidebar-panel-host
      prop:sessionKey={props.discussion!.sessionKey}
      prop:canOpen={props.discussion!.canOpen}
      prop:sourceGeneration={props.discussionSourceGeneration}
      prop:loadInfo={props.discussion!.loadInfo}
      prop:openDiscussion={props.discussion!.openDiscussion}
      prop:onStateChange={props.discussion!.onStateChange}
    />
  );
}

function PortalPanel(props: Props) {
  const presented = usePanePresentation(() => props.portalPresented ?? false);
  const portal = () =>
    props.state.sidebarLayout.columns
      .flatMap((column) => column.panels)
      .find((panel) => panel.slot === "portal");
  return (
    <openclaw-portals-page
      data-sidebar-panel-host
      prop:embedded={true}
      prop:presented={presented()}
      prop:requestedPortalId={portal()?.portalId ?? null}
      prop:requestedEnvironmentId={portal()?.environmentId ?? null}
    />
  );
}

function WorkspacePanel(props: Props & { workspaceState: SessionWorkspaceState }) {
  const browser = <SessionWorkspaceRail workspace={props.workspace} />;
  const Detail = (detail: { content: SidebarContent }) => (
    <ChatDetailSlot {...props.detail} content={detail.content} />
  );
  const presented = usePanePresentation(() => props.panePresentation ?? true);
  return (
    <openclaw-chat-files-panel
      data-sidebar-panel-host
      prop:tabsInHeader={sidebarMainPanel(props.state.sidebarLayout)?.slot !== "workspace"}
      prop:previews={presented() ? props.workspaceState.previews : []}
      prop:activeId={presented() ? props.workspaceState.activePreviewId : null}
      prop:browser={browser}
      prop:renderDetail={Detail}
      prop:onSelect={(id: string | null) => selectSessionWorkspacePreview(props.state, id)}
      prop:onClose={(id: string) => closeSessionWorkspacePreview(props.state, id)}
    />
  );
}

function SubagentsPanel(props: Props) {
  const presented = usePanePresentation(() => props.subagentsPresented);
  return (
    <openclaw-chat-subagents-panel
      data-sidebar-panel-host
      prop:sessionKey={props.state.sessionKey}
      prop:agentId={props.agentId ?? "main"}
      prop:paneId={props.paneId}
      prop:presentationId={props.panePresentationId}
      prop:inputRegion={props.subagentsInputRegion}
      prop:presented={presented()}
      prop:showRequest={props.subagentsShowRequest}
      prop:onSessionSelect={props.onSubagentSessionSelect}
    />
  );
}

function ProcessesPanel(props: Props) {
  const presented = usePanePresentation(() => props.processesPresented ?? false);
  return (
    <openclaw-chat-processes-panel
      data-sidebar-panel-host
      prop:sessionKey={props.state.sessionKey}
      prop:agentId={props.agentId ?? "main"}
      prop:presented={presented()}
    />
  );
}

function LinkReaderPanel(props: Props) {
  const presented = usePanePresentation(() => props.linkReaderPresented ?? false);
  return (
    <openclaw-link-reader-panel
      data-sidebar-panel-host
      prop:embedded={true}
      data-chat-autotype-exempt
      prop:client={props.state.client}
      prop:available={props.state.connected}
      prop:readers={props.linkReaders ?? EMPTY_LINK_READERS}
      prop:agentId={props.agentId ?? undefined}
      prop:sessionKey={props.state.sessionKey}
      prop:presented={presented()}
      prop:tabsInHeader={props.linkReaderTabsInHeader ?? true}
      prop:onClose={props.onCloseLinkReader}
    />
  );
}

export function ExternalPanelLink(props: { href: string; label: string }) {
  return (
    <a
      class="rail-header__action"
      href={props.href}
      target="_blank"
      rel="noopener"
      aria-label={props.label}
      title={props.label}
    >
      <Icon name="externalLink" />
    </a>
  );
}

export function ClearCompanion(props: Props) {
  return (
    <openclaw-tooltip prop:content={t("chat.rail.clear")}>
      <button
        class="rail-header__action chat-session-rail__clear"
        type="button"
        aria-label={t("chat.rail.clear")}
        disabled={
          !props.connected || props.companion.turns.some((turn) => turn.status === "pending")
        }
        onClick={() => props.onClearCompanion()}
      >
        <Icon name="trash" />
      </button>
    </openclaw-tooltip>
  );
}

function DetailPanel(props: SidebarPanelData) {
  const presented = usePanePresentation(() => props.detailPresentation);
  return (
    <Show when={presented()}>
      <ChatDetailSlot {...props.detail} content={props.detailContent!} />
    </Show>
  );
}

function DashboardPanel(props: SidebarPanelData) {
  return <ChatBoardPanel {...props.dashboard!} />;
}

const embeddedPanels: Partial<
  Record<SidebarSlotId, (props: SidebarPanelData) => SolidJSX.Element>
> = {
  terminal: TerminalPanel,
  browser: BrowserPanel,
  companion: CompanionPanel,
  desktop: DesktopPanel,
  discussion: DiscussionPanel,
  portal: PortalPanel,
  subagents: SubagentsPanel,
  processes: ProcessesPanel,
  "link-reader": LinkReaderPanel,
  workspace: WorkspacePanel,
  detail: DetailPanel,
  dashboard: DashboardPanel,
};

export function SidebarPanel(props: { definition: SidebarPanelDefinition }) {
  const Panel = dynamic(() => embeddedPanels[props.definition.slot]);
  return (
    <Switch>
      <Match when={props.definition.loadState === null}>
        <PanelLoadingSkeleton {...props.definition.loading} />
      </Match>
      <Match when={props.definition.loadState}>{(error) => <LazyViewError {...error()} />}</Match>
      <Match when={props.definition.view}>
        {(data) => (
          <Show when={props.definition.slot.startsWith("plugin:")} fallback={<Panel {...data()} />}>
            <EmbeddedPluginPanel
              contributionKey={props.definition.slot.slice("plugin:".length)}
              props={{
                sessionKey: data().state.sessionKey,
                agentId: data().agentId ?? undefined,
              }}
              presentation={data().isPluginPanelPresented(props.definition.slot)}
            />
          </Show>
        )}
      </Match>
      <Match when={props.definition.content != null}>{props.definition.content}</Match>
    </Switch>
  );
}

type EmbeddedAttributes<Element extends HTMLElement> = SolidJSX.HTMLAttributes<Element> &
  ElementProperties<Omit<Element, keyof HTMLElement | "updateComplete">>;
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-session-rail": HTMLAttributes<HTMLElement> & {
        "prop:sessionKey"?: SidebarPanelDefinitionParams["state"]["sessionKey"];
        "prop:digest"?: SidebarPanelDefinitionParams["digest"];
        "prop:running"?: boolean;
        "prop:activeRunId"?: SidebarPanelDefinitionParams["activeRunId"];
        "prop:pullRequests"?: SidebarPanelDefinitionParams["pullRequests"];
        "prop:companion"?: SidebarPanelDefinitionParams["companion"];
        "prop:connected"?: boolean;
        "prop:sendShortcut"?: SidebarPanelDefinitionParams["state"]["settings"]["chatSendShortcut"];
        "prop:onSubmit"?: SidebarPanelDefinitionParams["onCompanionSubmit"];
        "prop:onDraftChange"?: SidebarPanelDefinitionParams["onCompanionDraftChange"];
        "prop:onAttachmentsChange"?: SidebarPanelDefinitionParams["onCompanionAttachmentsChange"];
        "prop:uploadConfig"?: SidebarPanelDefinitionParams["state"]["uploadConfig"];
        "prop:attachmentLimits"?: ReturnType<typeof resolveChatAttachmentLimits>;
        "prop:presented"?: boolean;
        "prop:focusRequest"?: SidebarPanelDefinitionParams["companionFocusRequest"];
      };
      "openclaw-portals-page": EmbeddedAttributes<HTMLElementTagNameMap["openclaw-portals-page"]>;
      "openclaw-chat-files-panel": EmbeddedAttributes<
        HTMLElementTagNameMap["openclaw-chat-files-panel"]
      >;
      "openclaw-chat-subagents-panel": EmbeddedAttributes<
        HTMLElementTagNameMap["openclaw-chat-subagents-panel"]
      >;
      "openclaw-chat-processes-panel": EmbeddedAttributes<
        HTMLElementTagNameMap["openclaw-chat-processes-panel"]
      >;
      "openclaw-session-discussion": EmbeddedAttributes<
        HTMLElementTagNameMap["openclaw-session-discussion"]
      >;
    }
  }
}
