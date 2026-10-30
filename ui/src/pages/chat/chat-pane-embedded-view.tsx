import { dynamic, type JSX as SolidJSX } from "@solidjs/web";
import { Match, Show, Switch, createMemo, createSignal, lazy } from "solid-js";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import { isBrowserPanelAvailable } from "../../app/panel-availability.ts";
import { EMPTY_LINK_READERS } from "../../components/link-reader-target.ts";
import { PanelLoadingSkeleton } from "../../components/solid/panel-loading-skeleton.tsx";
import { registerChatSessionOptionalEnglish } from "../../i18n/locales/en-chat-session-optional.ts";
import { elementRef } from "../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { ContentPresentation } from "../../lib/solid/presentation.ts";
import type { ElementProperties } from "../../types/solid-elements.d.ts";
import { buildChatBoardPanel } from "./chat-pane-board-panel.ts";
import { buildChatDiscussionPanel } from "./chat-pane-discussion-panel.ts";
import type { SidebarPanelDefinitionParams, SidebarPanelData } from "./chat-pane-embedded-types.ts";
import { EmbeddedPluginPanel } from "./chat-pane-plugin-panel.tsx";
import { usePanePresentation } from "./chat-pane-presentation.ts";
import { ChatBoardPanel } from "./chat-pane-surfaces.tsx";
import { ChatDetailSlot } from "./components/chat-detail-slot-view.tsx";
import { ChatLazyBoundary } from "./components/chat-lazy-boundary.tsx";
import type { ChatSessionRailElement } from "./components/chat-session-rail.tsx";
import {
  requestCloseSessionWorkspacePreview,
  pinSessionWorkspacePreview,
  setSessionWorkspacePreviewDraft,
  browseSessionWorkspacePreviewPath,
  selectSessionWorkspacePreview,
} from "./components/chat-session-workspace-state.ts";
import type { SessionWorkspaceState } from "./components/chat-session-workspace-types.ts";
import type { SidebarContent } from "./components/chat-sidebar-content-types.ts";
import type {
  SidebarPanelDefinition,
  SidebarPanelHostRegistration,
} from "./components/chat-sidebar-region-types.ts";
import { resolveChatLinkFaviconFetcher } from "./link-favicon-loader.ts";
import type { SidebarSlotId } from "./sidebar-layout-types.ts";
import { sidebarMainPanel } from "./sidebar-layout.ts";

registerEnglishCatalog(registerChatSessionOptionalEnglish);

type PanelHostProps = { registerPanelHost?: SidebarPanelHostRegistration };
type Props = SidebarPanelDefinitionParams & PanelHostProps;

const Terminal = lazy(() => import("../../components/terminal/terminal-panel-registration.tsx"), {
  export: "TerminalPanelHost",
});
const Browser = lazy(() => import("../../components/browser/browser-panel.ts"), {
  export: "BrowserPanelHost",
});
const Context = lazy(() => import("./components/chat-context-panel.tsx"), {
  export: "ChatContextPanel",
});
const Companion = lazy(() => import("./components/chat-session-rail.tsx"), {
  export: "ChatSessionRailPanel",
});
const Desktop = lazy(() => import("../../components/desktop/desktop-panel-solid.tsx"), {
  export: "DesktopPanel",
});
const Discussion = lazy(() => import("./components/session-discussion-panel.tsx"), {
  export: "SessionDiscussionPanel",
});
const Portals = lazy(() => import("../portals/portals-page.tsx"), { export: "PortalsPage" });
const Files = lazy(() => import("./components/chat-files-panel.tsx"), { export: "ChatFilesPanel" });
const Subagents = lazy(() => import("./components/chat-subagents-panel.tsx"), {
  export: "ChatSubagentsPanel",
});
const Processes = lazy(() => import("./components/chat-processes-panel.tsx"), {
  export: "ChatProcessesPanel",
});
const LinkReader = lazy(() => import("../../components/link-reader-panel.tsx"), {
  export: "LinkReaderPanel",
});

function TerminalPanel(props: Props) {
  return (
    <Terminal
      mobile={props.presentation === "mobile"}
      data-sidebar-panel-host
      ref={[elementRef(props.registerPanelHost)]}
      embedded={true}
      tabsInHeader={props.terminalTabsInHeader}
      onClose={props.onCloseTerminal}
      client={props.state.client}
      gatewayConnected={props.state.connected}
      available={props.state.terminalAvailable}
      agentId={props.agentId}
      sessionKey={props.state.sessionKey}
      themeMode={props.themeMode}
      basePath={props.state.basePath}
    />
  );
}

function BrowserPanel(props: Props) {
  const presented = usePanePresentation(() => props.browserPresented);
  return (
    <Browser
      data-sidebar-panel-host
      ref={[elementRef(props.registerPanelHost)]}
      embedded={true}
      data-chat-autotype-exempt
      client={props.state.connected ? props.state.client : null}
      available={props.state.browserPanelAvailable}
      remoteAvailable={isBrowserPanelAvailable({
        phase: props.state.connected ? "connected" : "offline",
        hello: props.state.hello,
      })}
      presented={presented()}
      tabsInHeader={props.browserTabsInHeader}
      mobilePresentation={props.presentation === "mobile"}
      fetchFavicon={resolveChatLinkFaviconFetcher(props.state)}
      refreshOnPresentation={props.browserRefreshOnPresentation}
      sessionKey={props.state.sessionKey}
      preferredTab={props.preferredBrowserTab}
      sessionTabs={props.sessionBrowserTabs ?? []}
      resourceBasePath={props.state.resourceBasePath}
      authToken={resolveControlUiAuthToken(props.state)}
    />
  );
}

function DesktopPanel(props: Props) {
  const presented = usePanePresentation(() => props.desktopPresented);
  return (
    <Desktop
      presentation={
        props.presentation
          ? {
              platform: props.presentation,
              expanded: props.desktopExpanded,
              onToggleExpanded: props.onToggleDesktopExpanded,
              openWindowHref: props.desktopFocusHref,
            }
          : undefined
      }
      data-sidebar-panel-host
      ref={[elementRef(props.registerPanelHost)]}
      embedded={true}
      data-chat-autotype-exempt
      client={props.state.connected ? props.state.client : null}
      available={props.desktopAvailable}
      presented={presented()}
      refreshOnPresentation={props.desktopRefreshOnPresentation}
      requestedSource={props.desktopSource}
      runtimeConfig={props.desktopRuntimeConfig}
      sessionKey={props.state.sessionKey}
      onFocusTargetChange={props.onDesktopFocusTargetChange}
    />
  );
}

function DiscussionPanel(props: Props) {
  const config = createMemo(() => buildChatDiscussionPanel(props.discussion!));
  return (
    <Discussion
      presentation={props.presentation}
      data-sidebar-panel-host
      ref={[elementRef(props.registerPanelHost)]}
      sessionKey={config().sessionKey}
      canOpen={config().canOpen}
      sourceGeneration={props.discussionSourceGeneration}
      loadInfo={config().loadInfo}
      openDiscussion={config().openDiscussion}
      onStateChange={config().onStateChange}
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
    <Portals
      mobile={props.presentation === "mobile"}
      data-sidebar-panel-host
      ref={[elementRef(props.registerPanelHost)]}
      embedded={true}
      presented={presented()}
      requestedPortalId={portal()?.portalId ?? null}
      requestedEnvironmentId={portal()?.environmentId ?? null}
    />
  );
}

function WorkspacePanel(props: Props & { workspaceState: SessionWorkspaceState }) {
  const presented = usePanePresentation(() => props.panePresentation ?? true);
  const workspaceVisible = usePanePresentation(
    () => props.workspacePresented ?? props.panePresentation ?? true,
  );
  const browserPresented = () =>
    workspaceVisible() &&
    (props.workspace?.presentation === "desktop" ||
      props.workspaceState.activePreviewId === null ||
      props.workspaceState.previews.find(
        (entry) => entry.id === props.workspaceState.activePreviewId,
      )?.catalogVisible === true);
  const Detail = (detail: {
    content: SidebarContent;
    previewId: string;
    onBrowseFiles: () => void;
  }) => {
    const preview = () =>
      props.workspaceState.previews.find((entry) => entry.id === detail.previewId);
    const fileSource = () =>
      detail.content.kind === "file"
        ? detail.content
        : detail.content.kind === "image" ||
            detail.content.kind === "attachment" ||
            detail.content.kind === "markdown"
          ? detail.content.file
          : undefined;
    const active = () =>
      workspaceVisible() &&
      props.workspaceState.activePreviewId === detail.previewId &&
      preview()?.catalogVisible !== true;
    return (
      <ContentPresentation value={active}>
        <ChatDetailSlot
          {...props.detail}
          active={active()}
          content={detail.content}
          filePresentation={props.workspace?.presentation}
          onBrowseFiles={detail.onBrowseFiles}
          fileBack={
            props.workspace?.presentation === "mobile"
              ? {
                  label: t("chat.sidePanel.files"),
                  onBack: () => selectSessionWorkspacePreview(props.state, null),
                }
              : undefined
          }
          fileWorkspace={
            fileSource() && (fileSource()!.root || fileSource()!.artifactId) && props.workspace
              ? {
                  path: fileSource()!.path,
                  rootLabel: t("chat.workspaceFiles.root"),
                  sourceLabel: fileSource()!.artifactId
                    ? t("chat.workspaceFiles.desktop.sessionFiles")
                    : undefined,
                  catalog: props.workspace,
                  showingFolder: preview()?.catalogVisible === true,
                  onBrowsePath: (path) => {
                    browseSessionWorkspacePreviewPath(props.state, detail.previewId, path);
                  },
                }
              : undefined
          }
          onFileInteraction={(file) => {
            if (file === detail.content) {
              pinSessionWorkspacePreview(props.state, detail.previewId);
            }
          }}
          onFileDraftChange={(draft) =>
            setSessionWorkspacePreviewDraft(props.state, detail.previewId, draft)
          }
        />
      </ContentPresentation>
    );
  };
  return (
    <Files
      data-sidebar-panel-host
      ref={[elementRef(props.registerPanelHost)]}
      sessionKey={props.state.sessionKey}
      tabsInHeader={sidebarMainPanel(props.state.sidebarLayout)?.slot !== "workspace"}
      previews={presented() ? props.workspaceState.previews : []}
      activeId={presented() ? props.workspaceState.activePreviewId : null}
      presentation={props.workspace?.presentation}
      treeVisible={props.workspace?.navigation?.treeVisible !== false}
      folderView={props.workspace?.folderView === true}
      workspace={props.workspace}
      browserPresented={browserPresented}
      renderDetail={Detail}
      onSelect={(id: string | null) => selectSessionWorkspacePreview(props.state, id)}
      onClose={(id: string) => requestCloseSessionWorkspacePreview(props.state, id)}
    />
  );
}

function SubagentsPanel(props: Props) {
  const presented = usePanePresentation(() => props.subagentsPresented);
  return (
    <Subagents
      onScrollPortRef={props.onScrollPortRef}
      mobile={props.presentation === "mobile"}
      data-sidebar-panel-host
      ref={[elementRef(props.registerPanelHost)]}
      sessionKey={props.state.sessionKey}
      agentId={props.agentId ?? "main"}
      paneId={props.paneId}
      presentationId={props.panePresentationId}
      inputRegion={props.subagentsInputRegion}
      presented={presented()}
      showRequest={props.subagentsShowRequest}
      onSessionSelect={props.onSubagentSessionSelect}
    />
  );
}

function ContextPanel(props: Props) {
  const presented = usePanePresentation(() => props.contextPresented ?? false);
  return (
    <Context
      data-sidebar-panel-host
      ref={[elementRef(props.registerPanelHost)]}
      details={props.contextDetails}
      presented={presented()}
      onScrollPortRef={props.onScrollPortRef}
    />
  );
}

function ProcessesPanel(props: Props) {
  const presented = usePanePresentation(() => props.processesPresented ?? false);
  return (
    <Processes
      showRequest={props.processesShowRequest}
      onBackToDetails={props.onBackToProcessDetails}
      onScrollPortRef={props.onScrollPortRef}
      mobile={props.presentation === "mobile"}
      data-sidebar-panel-host
      ref={[elementRef(props.registerPanelHost)]}
      sessionKey={props.state.sessionKey}
      agentId={props.agentId ?? "main"}
      presented={presented()}
    />
  );
}

function LinkReaderPanel(props: Props) {
  const presented = usePanePresentation(() => props.linkReaderPresented ?? false);
  return (
    <LinkReader
      onScrollPortRef={props.onScrollPortRef}
      mobile={props.presentation === "mobile"}
      data-sidebar-panel-host
      ref={[elementRef(props.registerPanelHost)]}
      embedded={true}
      data-chat-autotype-exempt
      client={props.state.client}
      available={props.state.connected}
      readers={props.linkReaders ?? EMPTY_LINK_READERS}
      agentId={props.agentId ?? undefined}
      sessionKey={props.state.sessionKey}
      presented={presented()}
      tabsInHeader={props.linkReaderTabsInHeader ?? true}
      onClose={props.onCloseLinkReader}
    />
  );
}

function DetailPanel(props: SidebarPanelData) {
  const presented = usePanePresentation(() => props.detailPresentation);
  const active = usePanePresentation(() => props.detailPresented ?? props.detailPresentation);
  return (
    <Show when={presented()}>
      <ChatDetailSlot {...props.detail} active={active()} content={props.detailContent!} />
    </Show>
  );
}

function DashboardPanel(props: SidebarPanelData) {
  return <ChatBoardPanel {...buildChatBoardPanel(props.dashboard!)} />;
}

const embeddedPanels: Partial<
  Record<SidebarSlotId, (props: SidebarPanelData & PanelHostProps) => SolidJSX.Element>
> = {
  terminal: TerminalPanel,
  browser: BrowserPanel,
  companion: Companion,
  desktop: DesktopPanel,
  discussion: DiscussionPanel,
  portal: PortalPanel,
  subagents: SubagentsPanel,
  processes: ProcessesPanel,
  context: ContextPanel,
  "link-reader": LinkReaderPanel,
  workspace: WorkspacePanel,
  detail: DetailPanel,
  dashboard: DashboardPanel,
};

export function SidebarPanel(
  props: { definition: SidebarPanelDefinition; visible?: boolean } & PanelHostProps,
) {
  const Panel = dynamic(() => embeddedPanels[props.definition.slot]);
  // Heavy saved tabs stay cold until first shown, then retain their controls while hidden.
  const [activated] = createSignal(
    (previous = false) =>
      previous ||
      (props.definition.slot !== "dashboard" &&
        props.definition.slot !== "workspace" &&
        props.definition.slot !== "context" &&
        props.definition.slot !== "companion") ||
      props.visible !== false,
  );
  return (
    <Show when={activated()}>
      <ChatLazyBoundary fallback={<PanelLoadingSkeleton {...props.definition.loading} />}>
        <Switch>
          <Match when={props.definition.view}>
            {(data) => (
              <Show
                when={props.definition.slot.startsWith("plugin:")}
                fallback={<Panel {...data()} registerPanelHost={props.registerPanelHost} />}
              >
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
      </ChatLazyBoundary>
    </Show>
  );
}

type EmbeddedAttributes<Element extends HTMLElement> = SolidJSX.HTMLAttributes<Element> &
  ElementProperties<Omit<Element, keyof HTMLElement | "updateComplete">>;
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-session-rail": EmbeddedAttributes<ChatSessionRailElement>;
      "openclaw-portals-page": EmbeddedAttributes<HTMLElementTagNameMap["openclaw-portals-page"]>;
      "openclaw-chat-files-panel": EmbeddedAttributes<
        HTMLElementTagNameMap["openclaw-chat-files-panel"]
      >;
      "openclaw-chat-subagents-panel": EmbeddedAttributes<
        HTMLElementTagNameMap["openclaw-chat-subagents-panel"]
      >;
      "openclaw-chat-context-panel": EmbeddedAttributes<
        HTMLElementTagNameMap["openclaw-chat-context-panel"]
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
