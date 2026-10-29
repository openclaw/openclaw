import { createMemo, lazy } from "solid-js";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatDetailSlotProps } from "../chat-pane-embedded-types.ts";
import { selectedChatSessionRow } from "../chat-state-route.ts";
import { openSlot } from "../sidebar-layout.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { assistantMediaPolicyKey } from "./chat-message-media.ts";
import { getSessionWorkspace } from "./chat-session-workspace-state.ts";
import {
  openSessionWorkspaceFile,
  openSessionWorkspaceFileView,
  revealSessionWorkspaceFile,
} from "./chat-session-workspace.ts";
import type { WorkspaceFileLinkTarget } from "./chat-sidebar-content-types.ts";

// The output formatter belongs to the selected detail, not ordinary chat boot.
const ChatToolOutput = lazy(() => import("./chat-tool-output-view.tsx"), {
  export: "ChatToolOutput",
});
const ChatDetailPanel = lazy(() => import("./chat-detail-panel.tsx"), {
  export: "ChatDetailPanel",
});

export function ChatDetailSlot(props: ChatDetailSlotProps) {
  const attachmentRuntime = createMemo(() => ({
    sessionKey: props.chat.sessionKey,
    agentId: props.chat.currentAgentId ?? props.chat.fullMessageAgentId,
    policyKey: assistantMediaPolicyKey(props.chat.selectedSession, props.chat.mediaPolicyEpoch),
    authToken: props.chat.assistantAttachmentAuthToken,
    connectionEpoch: props.chat.connectionEpoch,
    resourceBasePath: props.chat.resourceBasePath,
    resolveArtifactDownload: props.chat.resolveArtifactDownload,
  }));
  const sourceContent = createMemo(() => props.content);
  const content = createMemo(() => {
    const value = sourceContent();
    if (value.kind === "tool-output" || value.kind === "loading" || value.kind === "unavailable") {
      return null;
    }
    if (value.kind !== "session-diff") {
      return value;
    }
    const openFile = value.openFile;
    return {
      ...value,
      presentation: {
        ...value.presentation,
        openFileView:
          value.presentation?.openFileView ??
          (value.openFile
            ? (path: string, view: import("./chat-sidebar-content-types.ts").FileReaderView) => {
                if (value.owner !== getSessionWorkspace(props.host)) {
                  return;
                }
                // The workspace owner resolves aliases and retains the actual file/editor identity.
                void openSessionWorkspaceFileView(props.host, path, view);
                if (props.host.connected && props.host.client) {
                  props.onWorkspaceIntent?.();
                }
              }
            : undefined),
        get onOpenMobilePage() {
          return props.onOpenMobilePage ?? value.presentation?.onOpenMobilePage;
        },
      },
      openFile: openFile
        ? (path: string) => {
            const result = openFile(path);
            if (props.host.connected && props.host.client) {
              props.onWorkspaceIntent?.();
            }
            return result;
          }
        : undefined,
    };
  });
  return (
    <>
      {props.content.kind === "loading" ? (
        <PanelLoadingSkeleton variant="review" label={t("common.loading")} />
      ) : props.content.kind === "unavailable" ? (
        <div class="callout danger review-unavailable" role="alert">
          <strong>{t("chat.detailPanel.unavailable")}</strong>
          <span>{props.content.message}</span>
        </div>
      ) : props.content.kind === "tool-output" ? (
        <ChatLazyBoundary
          fallback={<PanelLoadingSkeleton variant="review" label={t("common.loading")} />}
        >
          <ChatToolOutput
            class="chat-sidebar"
            content={props.content}
            loadFullMessage={props.chat.loadFullAssistantMessage ?? null}
            connectionEpoch={props.chat.connectionEpoch}
          />
        </ChatLazyBoundary>
      ) : (
        <ChatLazyBoundary
          fallback={<PanelLoadingSkeleton variant="review" label={t("common.loading")} />}
        >
          <ChatDetailPanel
            class="chat-sidebar"
            content={content()}
            attachmentChat={props.chat}
            onScrollPortRef={props.chat.onScrollPortRef}
            panelPresentation={props.presentation}
            filePresentation={props.filePresentation ?? props.presentation}
            panelActive={props.active ?? true}
            filePresented={props.active ?? true}
            fileBack={props.fileBack}
            fileWorkspace={props.fileWorkspace}
            onFileInteraction={props.onFileInteraction}
            onFileDraftChange={props.onFileDraftChange}
            fileNavigation={
              props.content.kind === "file" ? (props.content.navigation ?? null) : null
            }
            execNode={selectedChatSessionRow(props.host)?.execNode ?? null}
            attachmentRuntime={attachmentRuntime()}
            basePath={props.chat.basePath ?? ""}
            canvasPluginSurfaceUrl={props.host.canvasPluginSurfaceUrl}
            embedSandboxMode={props.host.embedSandboxMode}
            allowExternalEmbedUrls={props.host.allowExternalEmbedUrls}
            onOpenWorkspaceFile={(target: WorkspaceFileLinkTarget) => {
              void openSessionWorkspaceFile(
                props.host,
                target,
                (props.filePresentation ?? props.presentation) === "desktop"
                  ? "preview"
                  : undefined,
              );
              if (props.host.connected && props.host.client) {
                props.onWorkspaceIntent?.();
              }
            }}
            onOpenSessionLink={props.chat.onOpenSessionLink}
            onRevealInWorkspace={(path: string) => {
              revealSessionWorkspaceFile(props.host, path);
              props.host.updateSidebarLayout(openSlot(props.host.sidebarLayout, "workspace"));
              props.onWorkspaceIntent?.();
            }}
            onOpenImage={(item: Parameters<typeof props.host.handleOpenImage>[0]) =>
              props.host.handleOpenImage(item, props.host.beginImageOpen())
            }
            embedded={true}
            onChat-detail-panel-close={() =>
              props.host.handleCloseSidebar(
                props.content.kind === "attachment" ? "workspace" : "detail",
              )
            }
          />
        </ChatLazyBoundary>
      )}
    </>
  );
}
