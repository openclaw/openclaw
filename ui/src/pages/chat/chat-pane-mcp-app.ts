import { onCleanup } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { MCP_APP_OPEN_EVENT, type McpAppOpenDetail } from "../../components/mcp-app-launch.ts";
import {
  MCP_APP_RESOURCE_MENTION_EVENT,
  type McpAppResourceMentionDetail,
} from "../../components/mcp-app-resources.tsx";
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
import { mcpAppMessageInput } from "../../lib/mcp-app-message.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { uploadsEnabled } from "../../lib/uploads.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  releaseChatAttachmentPayloads,
  generateAttachmentId,
  registerChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  resolveChatAttachmentLimits,
  admitAttachmentFiles,
  chatAttachmentBatchBytes,
} from "./components/chat-attachment-admission.ts";
import { encodeTextAsDataUrl } from "./components/chat-attachment-text.ts";
import type { SessionWorkspacePreview } from "./components/chat-sidebar-content-types.ts";
import type { ChatComposerScope } from "./composer-persistence.ts";

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

type ChatPaneMcpAppState = ChatComposerScope &
  Pick<
    ChatPageHost,
    | "sessionKey"
    | "assistantAgentId"
    | "chatAttachments"
    | "uploadConfig"
    | "hello"
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
  replaceAttachments: (attachments: ChatPaneMcpAppState["chatAttachments"]) => void;
  /** Captures this state; the workspace owner still owns file admission and rendering. */
  openFile: (path: string) => void | Promise<SessionWorkspacePreview | undefined>;
};

/** Create inside the mounted pane's Solid owner. */
export function createChatPaneMcpApps(options: {
  element: HTMLElement;
  current: () => ChatPaneMcpAppOwner | null;
}): () => void {
  let disposed = false;
  let openedLaunch: McpAppOpenDetail | undefined;
  function syncLaunch(): void {
    const owner = options.current();
    const launch = owner?.launch;
    if (
      !owner ||
      !launch ||
      openedLaunch === launch ||
      launch.owner !== owner.context.gateway.snapshot.client ||
      launch.sessionKey !== owner.state.sessionKey
    ) {
      return;
    }
    openedLaunch = launch;
    openLaunch(owner, launch);
  }

  function openLaunch(owner: ChatPaneMcpAppOwner, launch: McpAppOpenDetail, fileSuffix = ""): void {
    owner.state.handleOpenSidebar({
      kind: "mcp-app",
      title: launch.entrypoint.title,
      launch,
      fileTab: {
        id: `mcp-app:${launch.serverName}/${launch.entrypoint.toolName}:${launch.settings ? "settings" : "app"}${fileSuffix}`,
        label: launch.entrypoint.title,
      },
    });
  }

  function presentedEventOwner(event: CustomEvent<{ sessionKey: string }>) {
    if (!(event instanceof CustomEvent) || event.defaultPrevented) {
      return null;
    }
    const owner = options.current();
    return owner?.presented && event.detail.sessionKey === owner.state.sessionKey ? owner : null;
  }

  function receiveWidgetPrompt(event: CustomEvent<WidgetPromptEventDetail>): void {
    const detail = event.detail;
    const text = typeof detail?.text === "string" ? detail.text.trim() : "";
    if (text) {
      void options.current()?.state.handleSendChat(text);
    }
  }

  function receiveResourceMention(event: CustomEvent<McpAppResourceMentionDetail>): void {
    const owner = presentedEventOwner(event);
    if (!owner || !uploadsEnabled(owner.state.uploadConfig)) {
      return;
    }
    const detail = event.detail;
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
    owner.replaceAttachments([...state.chatAttachments, attachment]);
  }

  function receiveMessage(event: CustomEvent<McpAppMessageEventDetail>): void {
    const owner = presentedEventOwner(event);
    if (!owner) {
      return;
    }
    const detail = event.detail;
    const { state, context } = owner;
    event.preventDefault();
    void (async () => {
      if (detail.target === "new") {
        const client = context.gateway.snapshot.client;
        const connectionGeneration = client?.connectionGeneration;
        const agentId = state.assistantAgentId || owner.agentId || "";
        const selectionIntent = context.agentSelection.intentRevision;
        const request = chatOutboxOwner(state).admissions.beginRequest(
          state,
          resolveUiConversationIdentity(state, state.sessionKey),
          generateUUID(),
        );
        try {
          const { sendMcpAppNewConversation } =
            await import("../../lib/mcp-app-new-conversation.ts");
          const current = options.current();
          if (
            disposed ||
            request.signal.aborted ||
            !current ||
            current.state !== state ||
            current.context !== context ||
            state.client !== client ||
            context.gateway.snapshot.client !== client ||
            client?.connectionGeneration !== connectionGeneration ||
            context.agentSelection.intentRevision !== selectionIntent ||
            state.sessionKey !== detail.sessionKey ||
            (state.assistantAgentId || current.agentId || "") !== agentId
          ) {
            return false;
          }
          return await sendMcpAppNewConversation(context, agentId, detail, request.signal);
        } finally {
          request.release();
        }
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

  function receiveFile(event: CustomEvent<McpAppFileOpenEventDetail>): void {
    const owner = presentedEventOwner(event);
    if (!owner) {
      return;
    }
    const detail = event.detail;
    event.preventDefault();
    void owner.openFile(detail.path);
    detail.respond(true);
  }

  function receiveContext(event: CustomEvent<McpAppContextEventDetail>): void {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    const detail = event.detail;
    const owner = options.current();
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

  function receiveOpen(event: CustomEvent<McpAppOpenDetail>): void {
    const owner = presentedEventOwner(event);
    const detail = event.detail;
    if (!owner || detail.owner !== owner.context.gateway.snapshot.client) {
      return;
    }
    event.preventDefault();
    openLaunch(owner, detail, `:${detail.filePath ?? ""}`);
  }

  // Pane-local listeners keep split-view prompts with their iframe.
  const element = options.element;
  const stopEvents = [
    listen(element, MCP_APP_RESOURCE_MENTION_EVENT, { handleEvent: receiveResourceMention }),
    listen(element, MCP_APP_MESSAGE_EVENT, { handleEvent: receiveMessage }),
    listen(element, MCP_APP_FILE_OPEN_EVENT, { handleEvent: receiveFile }),
    listen(element, MCP_APP_CONTEXT_EVENT, { handleEvent: receiveContext }),
    listen(element, MCP_APP_OPEN_EVENT, { handleEvent: receiveOpen }),
    listen(element, WIDGET_PROMPT_EVENT, { handleEvent: receiveWidgetPrompt }),
  ];
  onCleanup(() => {
    disposed = true;
    stopEvents.forEach((stop) => stop());
  });
  return syncLaunch;
}
