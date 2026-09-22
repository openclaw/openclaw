import type { ReactiveControllerHost } from "lit";
import { vi } from "vitest";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalScopeConfigured,
  uiSessionRowMatchesSelectedChat,
} from "../../lib/sessions/session-key.ts";
import type { renderChat } from "./chat-view.ts";
import {
  prepareChatMessageRender,
  resolveMessageActionDetails,
} from "./components/chat-message-markdown.ts";
import { ChatTranscriptController } from "./components/chat-transcript-controller.ts";

export function createTestTranscript(): ChatTranscriptController {
  return new ChatTranscriptController({
    addController: () => undefined,
    removeController: () => undefined,
    requestUpdate: () => undefined,
    updateComplete: Promise.resolve(true),
  } satisfies ReactiveControllerHost);
}

export function createPasteEvent(
  text: string,
  itemTypes: readonly string[] = ["text/plain"],
  extraData: Readonly<Record<string, string>> = {},
): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: Object.assign(Object.fromEntries(itemTypes.map((type, index) => [index, { type }])), {
        length: itemTypes.length,
      }),
      getData: (type: string) => (type === "text/plain" ? text : (extraData[type] ?? "")),
    },
  });
  return event;
}

export function appendChatBubble(
  container: Element,
  options: {
    entryId?: string;
    groupClass?: string;
    messageId?: string;
    senderLabel?: string;
    text?: string;
  } = {},
) {
  const group = document.createElement("div");
  group.className = options.groupClass ?? "chat-group";
  const bubble = Object.assign(document.createElement("div"), {
    messageActions: resolveMessageActionDetails(
      prepareChatMessageRender({
        role: "user",
        content: options.text ?? "",
        ...(options.entryId ? { __openclaw: { id: options.entryId } } : {}),
      }),
      {
        messageId: options.messageId ?? "test-message",
        senderLabel: options.senderLabel ?? "User",
        onReply: () => undefined,
      },
    ),
  });
  bubble.className = "chat-bubble";
  if (options.entryId) {
    bubble.dataset.entryId = options.entryId;
  }
  if (options.messageId) {
    bubble.dataset.messageId = options.messageId;
  }
  if (options.text) {
    bubble.dataset.messageText = options.text;
  }
  if (options.senderLabel) {
    const sender = document.createElement("span");
    sender.className = "chat-sender-name";
    sender.textContent = options.senderLabel;
    group.append(sender);
  }
  group.append(bubble);
  container.querySelector(".chat-thread-inner")?.append(group);
  return { bubble, group };
}

export function stubAnimationFrames() {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }),
  );
  return () => {
    for (const callback of callbacks.splice(0)) {
      callback(0);
    }
  };
}

type ChatProps = Parameters<typeof renderChat>[0];

export function createChatProps(overrides: Partial<ChatProps> = {}): ChatProps {
  const transcript = createTestTranscript();
  const sessionKey = overrides.sessionKey ?? "main";
  const sessionHost = overrides.sessionHost;
  const exactSelectedSession = overrides.sessions?.sessions.find((row) =>
    areUiSessionKeysEquivalent(row.key, sessionKey),
  );
  const selectedSession = Object.hasOwn(overrides, "selectedSession")
    ? overrides.selectedSession
    : (exactSelectedSession ??
      (sessionHost && isUiGlobalScopeConfigured(sessionHost)
        ? overrides.sessions?.sessions.find((row) =>
            uiSessionRowMatchesSelectedChat(sessionHost, row.key, sessionKey),
          )
        : undefined));
  return {
    transcript,
    paneId: "single",
    sessionKey,
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: false,
    showToolCalls: true,
    loading: false,
    sending: false,
    compactionStatus: null,
    fallbackStatus: null,
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    assistantAvatarUrl: null,
    draft: "",
    modelCatalog: [],
    modelSwitching: false,
    queue: [],
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle",
    realtimeTalkDetail: null,
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    runError: null,
    approvalCanGrant: false,
    sessions: null,
    selectedSession,
    canvasPluginSurfaceUrl: null,
    embedSandboxMode: "scripts",
    allowExternalEmbedUrls: false,
    assistantName: "Val",
    sendShortcut: "enter",
    assistantAvatar: null,
    userName: null,
    userAvatar: null,
    assistantAttachmentAuthToken: null,
    autoExpandToolCalls: false,
    attachments: [],
    onAttachmentsChange: () => undefined,
    showNewMessages: false,
    onScrollToBottom: () => undefined,
    onRefresh: () => undefined,
    getDraft: () => "",
    onDraftChange: () => undefined,
    onRequestUpdate: () => undefined,
    onSend: () => undefined,
    onToggleRealtimeTalk: () => undefined,
    onToggleRealtimeCamera: () => undefined,
    onDismissError: () => undefined,
    onAbort: () => undefined,
    onQueueRemove: () => undefined,
    onQueueSteer: () => undefined,
    onClearHistory: () => undefined,
    onOpenSessionCheckpoints: () => undefined,
    agentsList: null,
    currentAgentId: "main",
    onAgentChange: () => undefined,
    onNavigateToAgent: () => undefined,
    onSessionSelect: () => undefined,
    onOpenSidebar: () => undefined,
    onChatScroll: () => undefined,
    basePath: "",
    ...overrides,
  };
}
