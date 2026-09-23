import { expectDefined } from "@openclaw/normalization-core";
import { render, type ReactiveControllerHost } from "lit";
import { expect, vi } from "vitest";
import { buildFallbackSlashCommands, replaceSlashCommands } from "../../lib/chat/commands.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalScopeConfigured,
  uiSessionRowMatchesSelectedChat,
} from "../../lib/sessions/session-key.ts";
import { renderChat } from "./chat-view.ts";
import {
  prepareChatMessageRender,
  resolveMessageActionDetails,
} from "./components/chat-message-markdown.ts";
import { ChatTranscriptController } from "./components/chat-transcript-controller.ts";

export function requireElement(container: Element, selector: string, label: string): Element {
  const element = container.querySelector(selector);
  if (element === null) {
    throw new Error(`expected ${label}`);
  }
  return element;
}

export function getComposerTextarea(container: Element): HTMLTextAreaElement {
  return requireElement(
    container,
    ".agent-chat__composer-combobox > textarea",
    "composer textarea",
  ) as HTMLTextAreaElement;
}

let nextTestTranscriptId = 0;

export function createTestTranscript(
  paneId = `test-transcript-${++nextTestTranscriptId}`,
): ChatTranscriptController {
  return new ChatTranscriptController(
    {
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate: () => undefined,
      updateComplete: Promise.resolve(true),
    } satisfies ReactiveControllerHost,
    () => paneId,
  );
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

export function renderChatView(overrides: Partial<ChatProps> = {}) {
  const container = document.createElement("div");
  render(renderChat(createChatProps(overrides)), container);
  return container;
}

export function renderChatInto(container: HTMLElement, overrides: Partial<ChatProps> = {}) {
  render(renderChat(createChatProps(overrides)), container);
}

export function getChatModelSelect(container: Element): HTMLElement {
  const select = container.querySelector<HTMLElement>('[data-chat-model-select="true"]');
  expect(select).toBeInstanceOf(HTMLElement);
  if (!(select instanceof HTMLElement)) {
    throw new Error("Expected chat model control");
  }
  return select;
}

export function getChatThinkingValue(control: HTMLElement): string {
  return control.dataset.chatThinkingValue ?? "";
}

export function getThinkingSelect(container: Element): HTMLElement {
  const select = container.querySelector<HTMLElement>('[data-chat-thinking-select="true"]');
  expect(select).toBeInstanceOf(HTMLElement);
  if (!(select instanceof HTMLElement)) {
    throw new Error("Expected chat thinking control");
  }
  return select;
}

export function getThinkingSlider(container: Element): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('[data-chat-thinking-slider="true"]');
}

export function getThinkingSliderValues(container: Element): string[] {
  const values = getThinkingSlider(container)?.dataset.chatThinkingValues ?? "";
  return values ? values.split(",") : [];
}

export function getThinkingReasoningValueLabel(container: Element): string {
  const preview = container.querySelector(
    "[data-chat-thinking-preview-committed]:not([hidden]), " +
      "[data-chat-thinking-preview-index]:not([hidden])",
  );
  return preview?.textContent?.trim() ?? "";
}

export function createDragEvent(type: string, types = ["Files"]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types } });
  return event;
}

export function itemAt<T>(items: ArrayLike<T>, index: number, label: string): T {
  return expectDefined(items[index], `${label} ${index}`);
}

export function replaceSkillCommands(
  ...skills: Array<{ key: string; name?: string; skillDisplayName?: string; description: string }>
) {
  replaceSlashCommands([
    ...buildFallbackSlashCommands(),
    ...skills.map(({ key, name = key, skillDisplayName, description }) => ({
      key,
      name,
      skillDisplayName,
      description,
      source: "skill" as const,
      skillModelVisible: true,
    })),
  ]);
}

export function inputDraft(container: HTMLElement, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
  expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
  textarea!.value = value;
  textarea!.dispatchEvent(new Event("input", { bubbles: true }));
}

export function inputDraftAtEnd(container: HTMLElement, value: string) {
  const textarea = getComposerTextarea(container);
  textarea.value = value;
  textarea.setSelectionRange(value.length, value.length);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
}

export function keydownComposer(container: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
  expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
  const event = new KeyboardEvent("keydown", { ...init, key, bubbles: true, cancelable: true });
  textarea!.dispatchEvent(event);
  return event;
}

export function createReactiveDraftHarness({
  onDraftChange: observeDraftChange,
  ...overrides
}: Partial<ChatProps> = {}) {
  let draft = "";
  let currentOverrides = overrides;
  const container = document.createElement("div");
  const onDraftChange = vi.fn((next: string) => {
    draft = next;
    observeDraftChange?.(next);
  });
  const renderCurrent = (nextOverrides: Partial<ChatProps> = {}) => {
    currentOverrides = { ...currentOverrides, ...nextOverrides };
    renderChatInto(container, {
      draft,
      getDraft: () => draft,
      onDraftChange,
      onRequestUpdate: renderCurrent,
      ...currentOverrides,
    });
  };
  renderCurrent();
  return { container, renderCurrent };
}

export function createSlashRerenderHarness() {
  let draft = "";
  const onDraftChange = vi.fn((next: string) => {
    draft = next;
  });
  const renderCurrent = () => renderChatView({ draft, onDraftChange });
  return {
    container: renderCurrent(),
    inputAndRender(container: HTMLElement, value: string) {
      inputDraft(container, value);
      return renderCurrent();
    },
    renderCurrent,
  };
}
