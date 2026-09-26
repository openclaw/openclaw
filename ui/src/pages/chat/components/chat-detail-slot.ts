import { html, type TemplateResult } from "lit";
import type { ChatPageHost } from "../chat-state-host.ts";
import { selectedChatSessionRow } from "../chat-state-route.ts";
import type { ChatProps } from "../chat-view.ts";
import { openSlot } from "../sidebar-layout.ts";
import "./chat-sidebar.ts";
import "./chat-tool-output.ts";
import { assistantMediaPolicyKey } from "./chat-message-media.ts";
import { selectSessionWorkspacePreview } from "./chat-session-workspace-state.ts";
import { openSessionWorkspaceFile, revealSessionWorkspaceFile } from "./chat-session-workspace.ts";
import type { SidebarContent } from "./chat-sidebar.ts";

export function renderChatDetailSlot(params: {
  chat: ChatProps;
  content: SidebarContent;
  host: ChatPageHost;
}): TemplateResult {
  const { content, host } = params;
  if (content.kind === "tool-output") {
    return html`<openclaw-chat-tool-output
      class="chat-sidebar"
      .content=${content}
      .loadFullMessage=${params.chat.loadFullAssistantMessage ?? null}
      .connectionEpoch=${params.chat.connectionEpoch}
    ></openclaw-chat-tool-output>`;
  }
  return html`<openclaw-chat-detail-panel
    class="chat-sidebar"
    .content=${content}
    .fileNavigation=${content.kind === "file" ? (content.navigation ?? null) : null}
    .execNode=${selectedChatSessionRow(host)?.execNode ?? null}
    .attachmentRuntime=${{
      sessionKey: params.chat.sessionKey,
      agentId: params.chat.currentAgentId ?? params.chat.fullMessageAgentId,
      policyKey: assistantMediaPolicyKey(params.chat.selectedSession, params.chat.mediaPolicyEpoch),
      authToken: params.chat.assistantAttachmentAuthToken,
      connectionEpoch: params.chat.connectionEpoch,
      resourceBasePath: params.chat.resourceBasePath,
      resolveArtifactDownload: params.chat.resolveArtifactDownload,
    }}
    .basePath=${params.chat.basePath ?? ""}
    .canvasPluginSurfaceUrl=${host.canvasPluginSurfaceUrl}
    .embedSandboxMode=${host.embedSandboxMode}
    .allowExternalEmbedUrls=${host.allowExternalEmbedUrls}
    .githubContext=${{ githubRepo: params.chat.githubRepo, githubRepositories: params.chat.githubRepositories }}
    .onOpenWorkspaceFile=${(target: { path: string; line?: number | null }) =>
      openSessionWorkspaceFile(host, target)}
    .onOpenSessionLink=${params.chat.onOpenSessionLink}
    .onRevealInWorkspace=${(path: string) => {
      revealSessionWorkspaceFile(host, path);
      selectSessionWorkspacePreview(host, null);
      host.updateSidebarLayout(openSlot(host.sidebarLayout, "workspace"));
    }}
    .onOpenImage=${(item: Parameters<typeof host.handleOpenImage>[0]) =>
      host.handleOpenImage(item, host.beginImageOpen())}
    .embedded=${true}
    @chat-detail-panel-close=${() =>
      host.handleCloseSidebar(content.kind === "attachment" ? "workspace" : "detail")}
  ></openclaw-chat-detail-panel>`;
}
