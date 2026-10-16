import { createMemo } from "solid-js";
import type { MarkdownFileLinkTarget } from "../../../components/markdown-file-links.ts";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { LitContent, solidContent } from "../../../lit/solid-content.tsx";
import { ensureLazySidebarElement } from "../chat-pane-sidebar-layout.ts";
import type { ChatPageHost } from "../chat-state-host.ts";
import { selectedChatSessionRow } from "../chat-state-route.ts";
import type { ChatProps } from "../chat-view.tsx";
import { openSlot } from "../sidebar-layout.ts";
import { assistantMediaPolicyKey } from "./chat-message-media.ts";
import { selectSessionWorkspacePreview } from "./chat-session-workspace-state.ts";
import { openSessionWorkspaceFile, revealSessionWorkspaceFile } from "./chat-session-workspace.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import { ChatToolOutput } from "./chat-tool-output.ts";

type Props = {
  chat: ChatProps;
  content: SidebarContent;
  host: ChatPageHost;
  requestUpdate: () => void;
};

function ChatDetailSlot(props: Props) {
  const panelLoad = createMemo(() =>
    props.content.kind === "tool-output"
      ? undefined
      : ensureLazySidebarElement("detail-panel", props.requestUpdate),
  );
  return (
    <>
      {props.content.kind === "tool-output" ? (
        <ChatToolOutput
          class="chat-sidebar"
          content={props.content}
          loadFullMessage={props.chat.loadFullAssistantMessage ?? null}
          connectionEpoch={props.chat.connectionEpoch}
        />
      ) : panelLoad() !== undefined ? (
        panelLoad() === null ? (
          <PanelLoadingSkeleton variant="review" label={t("common.loading")} />
        ) : (
          <LitContent value={panelLoad()} />
        )
      ) : (
        <openclaw-chat-detail-panel
          class="chat-sidebar"
          prop:content={props.content}
          prop:fileNavigation={
            props.content.kind === "file" ? (props.content.navigation ?? null) : null
          }
          prop:execNode={selectedChatSessionRow(props.host)?.execNode ?? null}
          prop:attachmentRuntime={{
            sessionKey: props.chat.sessionKey,
            agentId: props.chat.currentAgentId ?? props.chat.fullMessageAgentId,
            policyKey: assistantMediaPolicyKey(
              props.chat.selectedSession,
              props.chat.mediaPolicyEpoch,
            ),
            authToken: props.chat.assistantAttachmentAuthToken,
            connectionEpoch: props.chat.connectionEpoch,
            resourceBasePath: props.chat.resourceBasePath,
            resolveArtifactDownload: props.chat.resolveArtifactDownload,
          }}
          prop:basePath={props.chat.basePath ?? ""}
          prop:canvasPluginSurfaceUrl={props.host.canvasPluginSurfaceUrl}
          prop:embedSandboxMode={props.host.embedSandboxMode}
          prop:allowExternalEmbedUrls={props.host.allowExternalEmbedUrls}
          prop:githubContext={{
            githubRepo: props.chat.githubRepo,
            githubRepositories: props.chat.githubRepositories,
          }}
          prop:onOpenWorkspaceFile={(target: MarkdownFileLinkTarget) =>
            openSessionWorkspaceFile(props.host, target)
          }
          prop:onOpenSessionLink={props.chat.onOpenSessionLink}
          prop:onRevealInWorkspace={(path: string) => {
            revealSessionWorkspaceFile(props.host, path);
            selectSessionWorkspacePreview(props.host, null);
            props.host.updateSidebarLayout(openSlot(props.host.sidebarLayout, "workspace"));
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

export function renderChatDetailSlot(params: Props) {
  return solidContent(ChatDetailSlot, params);
}
