import type { ApplicationContext } from "../../app/context.ts";
import { MCP_APP_OPEN_EVENT, type McpAppOpenDetail } from "../../components/mcp-app-launch.ts";
import {
  MCP_APP_RESOURCE_MENTION_EVENT,
  type McpAppResourceMentionDetail,
} from "../../components/mcp-app-resources.ts";
import {
  WIDGET_PROMPT_EVENT,
  MCP_APP_CONTEXT_EVENT,
  MCP_APP_MESSAGE_EVENT,
  MCP_APP_FILE_OPEN_EVENT,
  type McpAppMessageEventDetail,
  type McpAppFileOpenEventDetail,
  type McpAppContextEventDetail,
  type WidgetPromptEventDetail,
} from "../../components/mcp-app-security.ts";
import { t } from "../../i18n/index.ts";
import { registerMcpAppEnglish } from "../../i18n/locales/en-mcp-app.ts";
import { publishMcpAppContext } from "../../lib/mcp-app-context.ts";
import { mcpAppMessageInput, sendMcpAppNewConversation } from "../../lib/mcp-app-message.ts";
import { uploadsEnabled } from "../../lib/uploads.ts";
import {
  releaseChatAttachmentPayloads,
  generateAttachmentId,
  registerChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  resolveChatAttachmentLimits,
  admitAttachmentFiles,
  chatAttachmentBatchBytes,
} from "./components/chat-attachment-admission.ts";
import { encodeTextAsDataUrl } from "./components/chat-attachment-text.ts";

registerMcpAppEnglish();

// These are host-created DOM events. The sandbox bridge and catalog producers own
// their payloads; the handlers below still check the receiving pane and live client.
declare global {
  interface HTMLElementEventMap {
    [WIDGET_PROMPT_EVENT]: CustomEvent<WidgetPromptEventDetail>;
    [MCP_APP_RESOURCE_MENTION_EVENT]: CustomEvent<McpAppResourceMentionDetail>;
    [MCP_APP_MESSAGE_EVENT]: CustomEvent<McpAppMessageEventDetail>;
    [MCP_APP_FILE_OPEN_EVENT]: CustomEvent<McpAppFileOpenEventDetail>;
    [MCP_APP_CONTEXT_EVENT]: CustomEvent<McpAppContextEventDetail>;
    [MCP_APP_OPEN_EVENT]: CustomEvent<McpAppOpenDetail>;
  }
}

type ChatPaneMcpAppState = Pick<
  ChatPageHost,
  | "sessionKey"
  | "assistantAgentId"
  | "chatAttachments"
  | "uploadConfig"
  | "hello"
  | "requestUpdate"
  | "handleSendChat"
  | "handleOpenSidebar"
>;

/** Read at delivery, not subscription time: retained panes can change presentation/connection. */
export type ChatPaneMcpAppOwner = {
  context: ApplicationContext;
  state: ChatPaneMcpAppState;
  presented: boolean;
  agentId?: string;
  launch?: McpAppOpenDetail;
  /** Captures this state; the workspace owner still owns file admission and rendering. */
  openFile: (path: string) => void;
};

export class ChatPaneMcpAppController {
  private openedLaunch?: McpAppOpenDetail;

  constructor(
    private readonly options: {
      element: HTMLElement;
      current: () => ChatPaneMcpAppOwner | null;
    },
  ) {}

  subscribe(): () => void {
    // Listening on the containing pane keeps split-view prompts with their iframe.
    const element = this.options.element;
    const listen = <K extends keyof HTMLElementEventMap>(
      name: K,
      listener: (event: HTMLElementEventMap[K]) => void,
    ) => {
      element.addEventListener(name, listener);
      return () => element.removeEventListener(name, listener);
    };
    const cleanups = [
      listen(MCP_APP_RESOURCE_MENTION_EVENT, (event) => this.receiveResourceMention(event)),
      listen(MCP_APP_MESSAGE_EVENT, (event) => this.receiveMessage(event)),
      listen(MCP_APP_FILE_OPEN_EVENT, (event) => this.receiveFile(event)),
      listen(MCP_APP_CONTEXT_EVENT, (event) => this.receiveContext(event)),
      listen(MCP_APP_OPEN_EVENT, (event) => this.receiveOpen(event)),
      listen(WIDGET_PROMPT_EVENT, (event) => this.receiveWidgetPrompt(event)),
    ];
    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }

  syncLaunch(): void {
    const owner = this.options.current();
    const launch = owner?.launch;
    if (
      !owner ||
      !launch ||
      this.openedLaunch === launch ||
      launch.owner !== owner.context.gateway.snapshot.client ||
      launch.sessionKey !== owner.state.sessionKey
    ) {
      return;
    }
    this.openedLaunch = launch;
    owner.state.handleOpenSidebar({
      kind: "mcp-app",
      title: launch.entrypoint.title,
      launch,
      fileTab: {
        id: `mcp-app:${launch.serverName}/${launch.entrypoint.toolName}:${launch.settings ? "settings" : "app"}`,
        label: launch.entrypoint.title,
      },
    });
  }

  private receiveWidgetPrompt(event: CustomEvent<WidgetPromptEventDetail>): void {
    const detail = event.detail;
    const text = typeof detail?.text === "string" ? detail.text.trim() : "";
    if (text) {
      void this.options.current()?.state.handleSendChat(text);
    }
  }

  private receiveResourceMention(event: CustomEvent<McpAppResourceMentionDetail>): void {
    if (!(event instanceof CustomEvent) || event.defaultPrevented) {
      return;
    }
    const detail = event.detail;
    const owner = this.options.current();
    if (
      !owner ||
      !owner.presented ||
      detail.sessionKey !== owner.state.sessionKey ||
      !uploadsEnabled(owner.state.uploadConfig)
    ) {
      return;
    }
    const state = owner.state;
    const { resource } = detail;
    const title = resource.title || resource.name;
    const text = JSON.stringify({ serverName: detail.serverName, resource }, null, 2);
    const file = new File([text], `${title.replace(/[\\/]/gu, "-")}.txt`, { type: "text/plain" });
    if (
      !admitAttachmentFiles(
        [file],
        resolveChatAttachmentLimits(state.hello?.policy),
        chatAttachmentBatchBytes(state.chatAttachments),
      ).length
    ) {
      return;
    }
    event.preventDefault();
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: generateAttachmentId(),
        mimeType: file.type,
        fileName: file.name,
        sizeBytes: file.size,
        origin: "file",
      },
      dataUrl: encodeTextAsDataUrl(text),
      file,
    });
    state.chatAttachments = [...state.chatAttachments, attachment];
    state.requestUpdate();
  }

  private receiveMessage(event: CustomEvent<McpAppMessageEventDetail>): void {
    if (!(event instanceof CustomEvent) || event.defaultPrevented) {
      return;
    }
    const detail = event.detail;
    const owner = this.options.current();
    if (!owner || !owner.presented || detail.sessionKey !== owner.state.sessionKey) {
      return;
    }
    const { state, context } = owner;
    event.preventDefault();
    void (async () => {
      if (detail.target === "new") {
        return sendMcpAppNewConversation(
          context,
          state.assistantAgentId || owner.agentId || "",
          detail,
        );
      }
      const turn = mcpAppMessageInput(detail.content, context);
      let admitted = false;
      try {
        await state.handleSendChat(turn.text, {
          attachmentsOverride: turn.attachments,
          onOutboxAdmitted: () => {
            admitted = true;
          },
        });
        return admitted;
      } finally {
        if (!admitted) {
          releaseChatAttachmentPayloads(turn.attachments);
        }
      }
    })().then(detail.respond, () => detail.respond(false));
  }

  private receiveFile(event: CustomEvent<McpAppFileOpenEventDetail>): void {
    if (!(event instanceof CustomEvent) || event.defaultPrevented) {
      return;
    }
    const detail = event.detail;
    const owner = this.options.current();
    if (!owner || !owner.presented || detail.sessionKey !== owner.state.sessionKey) {
      return;
    }
    event.preventDefault();
    owner.openFile(detail.path);
    detail.respond(true);
  }

  private receiveContext(event: CustomEvent<McpAppContextEventDetail>): void {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    const detail = event.detail;
    const owner = this.options.current();
    const client = owner?.context.gateway.snapshot.client;
    if (!owner || !client || detail.sessionKey !== owner.state.sessionKey) {
      return;
    }
    const view = event
      .composedPath()
      .find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.localName === "mcp-app-view",
      );
    if (!view) {
      return;
    }
    publishMcpAppContext(client, {
      ...detail,
      agentId: owner.state.assistantAgentId ?? undefined,
      title: view.title || t("mcpApp.title"),
    });
  }

  private receiveOpen(event: CustomEvent<McpAppOpenDetail>): void {
    if (!(event instanceof CustomEvent) || event.defaultPrevented) {
      return;
    }
    const detail = event.detail;
    const owner = this.options.current();
    if (
      !owner ||
      !owner.presented ||
      detail.sessionKey !== owner.state.sessionKey ||
      detail.owner !== owner.context.gateway.snapshot.client
    ) {
      return;
    }
    event.preventDefault();
    owner.state.handleOpenSidebar({
      kind: "mcp-app",
      title: detail.entrypoint.title,
      launch: detail,
      fileTab: {
        id: `mcp-app:${detail.serverName}/${detail.entrypoint.toolName}:${detail.settings ? "settings" : "app"}:${detail.filePath ?? ""}`,
        label: detail.entrypoint.title,
      },
    });
  }
}
