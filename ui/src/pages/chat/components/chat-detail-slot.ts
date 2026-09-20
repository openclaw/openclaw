import { html, type TemplateResult } from "lit";
import type { ChatPageHost } from "../chat-state-host.ts";
import { selectedChatSessionRow } from "../chat-state-route.ts";
import type { ChatProps } from "../chat-view.ts";
import { openSlot, type SidebarLayout } from "../sidebar-layout.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import "./chat-sidebar.ts";
import { assistantMediaPolicyKey } from "./chat-message-media.ts";
import { selectSessionWorkspacePreview } from "./chat-session-workspace-state.ts";
import { openSessionWorkspaceFile, revealSessionWorkspaceFile } from "./chat-session-workspace.ts";
import type { SidebarContent, SidebarSelection } from "./chat-sidebar.ts";
import { renderTaskDetailPanel } from "./chat-task-detail.ts";

// Panel rendering and the Tasks highlight share the persisted detail selection.
// A selection only applies while its detail slot exists.
function detailSlotOpen(layout: SidebarLayout): boolean {
  return layout.columns.some((column) => column.panels.some((panel) => panel.slot === "detail"));
}

export function openTaskDetailId(
  content: SidebarSelection | null | undefined,
  layout: SidebarLayout,
): string | undefined {
  if (!detailSlotOpen(layout)) {
    return undefined;
  }
  if (content) {
    return content.kind === "task" ? content.taskId : undefined;
  }
  return layout.columns.flatMap((column) => column.panels).find((panel) => panel.slot === "detail")
    ?.taskId;
}

export function renderChatDetailSlot(params: {
  backgroundTasks: BackgroundTasksProps;
  chat: ChatProps;
  content: SidebarContent;
  host: ChatPageHost;
  layout: SidebarLayout;
}): TemplateResult {
  const { content, host } = params;
  const taskId = openTaskDetailId(content, params.layout);
  const documents: Partial<Record<SidebarContent["kind"], TemplateResult>> = {
    task:
      taskId === undefined
        ? html``
        : renderTaskDetailPanel({
            backgroundTasks: params.backgroundTasks,
            host,
            loadFullAssistantMessage: params.chat.loadFullAssistantMessage,
            task:
              params.backgroundTasks.tasks?.find((task) => task.id === taskId) ??
              params.backgroundTasks.taskDetails.get(taskId),
            taskId,
          }),
  };
  return (
    documents[content.kind] ??
    html`<openclaw-chat-detail-panel
      class="chat-sidebar"
      .content=${content}
      .fileNavigation=${content.kind === "file" ? (content.navigation ?? null) : null}
      .execNode=${selectedChatSessionRow(host)?.execNode ?? null}
      .attachmentRuntime=${{
        sessionKey: params.chat.sessionKey,
        agentId: params.chat.currentAgentId ?? params.chat.fullMessageAgentId,
        policyKey: assistantMediaPolicyKey(
          params.chat.selectedSession,
          params.chat.mediaPolicyEpoch,
        ),
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
    ></openclaw-chat-detail-panel>`
  );
}
