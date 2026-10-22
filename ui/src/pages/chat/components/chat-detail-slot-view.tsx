import { createMemo, lazy, Loading } from "solid-js";
import type { MarkdownFileLinkTarget } from "../../../components/markdown-file-links.ts";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import type { ChatDetailSlotProps } from "../chat-pane-embedded-types.ts";
import { ensureLazySidebarElement, lazySidebarElements } from "../chat-pane-sidebar-layout.ts";
import { selectedChatSessionRow } from "../chat-state-route.ts";
import { openSlot } from "../sidebar-layout.ts";
import { assistantMediaPolicyKey } from "./chat-message-media.ts";
import {
  getSessionWorkspace,
  selectSessionWorkspacePreview,
} from "./chat-session-workspace-state.ts";
import {
  openSessionWorkspaceFile,
  openSessionWorkspaceFileView,
  revealSessionWorkspaceFile,
} from "./chat-session-workspace.ts";

// The output formatter belongs to the selected detail, not ordinary chat boot.
const ChatToolOutput = lazy(() => import("./chat-tool-output-view.tsx"), {
  export: "ChatToolOutput",
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
  const elements = projectOwner(lazySidebarElements, (owner) => owner.snapshot);
  const panelLoad = createMemo(() => {
    elements.read();
    return props.content.kind === "tool-output" ||
      props.content.kind === "loading" ||
      props.content.kind === "unavailable"
      ? undefined
      : ensureLazySidebarElement("detail-panel");
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
        <Loading fallback={<PanelLoadingSkeleton variant="review" label={t("common.loading")} />}>
          <ChatToolOutput
            class="chat-sidebar"
            content={props.content}
            loadFullMessage={props.chat.loadFullAssistantMessage ?? null}
            connectionEpoch={props.chat.connectionEpoch}
          />
        </Loading>
      ) : panelLoad() !== undefined ? (
        panelLoad() === null ? (
          <PanelLoadingSkeleton variant="review" label={t("common.loading")} />
        ) : (
          <LazyViewError {...panelLoad()!} />
        )
      ) : (
        <openclaw-chat-detail-panel
          class="chat-sidebar"
          prop:content={content()}
          prop:attachmentChat={props.chat}
          prop:onScrollPortRef={props.chat.onScrollPortRef}
          prop:panelPresentation={props.presentation}
          prop:filePresentation={props.filePresentation ?? props.presentation}
          prop:panelActive={props.active ?? true}
          prop:filePresented={props.active ?? true}
          prop:fileBack={props.fileBack}
          prop:fileWorkspace={props.fileWorkspace}
          prop:onFileInteraction={props.onFileInteraction}
          prop:onFileDraftChange={props.onFileDraftChange}
          prop:fileNavigation={
            props.content.kind === "file" ? (props.content.navigation ?? null) : null
          }
          prop:execNode={selectedChatSessionRow(props.host)?.execNode ?? null}
          prop:attachmentRuntime={attachmentRuntime()}
          prop:basePath={props.chat.basePath ?? ""}
          prop:canvasPluginSurfaceUrl={props.host.canvasPluginSurfaceUrl}
          prop:embedSandboxMode={props.host.embedSandboxMode}
          prop:allowExternalEmbedUrls={props.host.allowExternalEmbedUrls}
          prop:onOpenWorkspaceFile={(target: MarkdownFileLinkTarget) => {
            void openSessionWorkspaceFile(
              props.host,
              target,
              (props.filePresentation ?? props.presentation) === "desktop" ? "preview" : undefined,
            );
            if (props.host.connected && props.host.client) {
              props.onWorkspaceIntent?.();
            }
          }}
          prop:onOpenSessionLink={props.chat.onOpenSessionLink}
          prop:onRevealInWorkspace={(path: string) => {
            revealSessionWorkspaceFile(props.host, path);
            selectSessionWorkspacePreview(props.host, null);
            props.host.updateSidebarLayout(openSlot(props.host.sidebarLayout, "workspace"));
            props.onWorkspaceIntent?.();
          }}
          prop:onOpenImage={(item: Parameters<typeof props.host.handleOpenImage>[0]) =>
            props.host.handleOpenImage(item, props.host.beginImageOpen())
          }
          prop:embedded={true}
          onChat-detail-panel-close={() =>
            props.host.handleCloseSidebar(
              props.content.kind === "attachment" ? "workspace" : "detail",
            )
          }
        />
      )}
    </>
  );
}
