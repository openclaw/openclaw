import { expectDefined } from "@openclaw/normalization-core";
import { createComponent, createSignal } from "solid-js";
import { expect, onTestFinished, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { buildFallbackSlashCommands, replaceSlashCommands } from "../../lib/chat/commands.ts";
import { createComposerDraftSource } from "../../lib/chat/composer-draft-changes.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalScopeConfigured,
  uiSessionRowMatchesSelectedChat,
} from "../../lib/sessions/session-key.ts";
import { createFrameQueue } from "../../test-helpers/animation-frame-queue.ts";
import { normalizeApplicationContext } from "../../test-helpers/application-context-fixtures.ts";
import { installModelPickerLayout } from "../../test-helpers/model-picker-layout.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { mountSolid as mountSolidComponent } from "../../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { composerContextWrapper, createComposerContainer } from "./chat-composer.test-support.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { ChatView, type ChatProps } from "./chat-view.tsx";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
import { registerMessageActionElements } from "./components/chat-message-action-elements.ts";
import {
  prepareChatMessageRender,
  resolveMessageActionDetails,
} from "./components/chat-message-markdown-view.tsx";
import { ChatModelControls } from "./components/chat-model-controls.tsx";
import {
  createChatTranscript,
  type ChatTranscript,
} from "./components/chat-transcript-controller.ts";

type ChatModelControlsProps = Parameters<typeof ChatModelControls>[0];
const modelControlsUpdates = new WeakMap<HTMLElement, (props: ChatModelControlsProps) => void>();

export async function renderChatModelControls(
  props: ChatModelControlsProps,
  container: HTMLDivElement,
) {
  installModelPickerLayout();
  const renderProps: ChatModelControlsProps = {
    ...props,
    modelPickerOpen: props.modelPickerOpen ?? true,
  };
  if (renderProps.modelPickerOpen) {
    await import("./components/chat-model-picker-panel.tsx");
  }
  const update = modelControlsUpdates.get(container);
  if (update) {
    update(renderProps);
  } else {
    if (!container.isConnected) {
      document.body.append(container);
      onTestFinished(() => container.remove());
    }
    const view = mountSolidComponent(ChatModelControls, renderProps, container);
    modelControlsUpdates.set(container, (next) => view.update(next));
  }
  if (renderProps.modelPickerOpen) {
    // The first open compiles the lazy panel under the full CI shard's load.
    await waitForSolid(
      () => expect(container.querySelector(".chat-controls__model-menu")).not.toBeNull(),
      { timeout: 5_000 },
    );
  }
  return container;
}

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
): ChatTranscript {
  return createChatTranscript(() => paneId);
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
  const { frames: callbacks, request } = createFrameQueue();
  vi.stubGlobal("requestAnimationFrame", vi.fn(request));
  return () => {
    for (const callback of callbacks.splice(0)) {
      callback(0);
    }
  };
}

export function stubSettledAnimationFrames() {
  const frame = stubAnimationFrames();
  return () => {
    frame();
    flush();
  };
}

export function createChatProps(overrides: Partial<ChatProps> = {}): ChatProps {
  const transcript = overrides.transcript ?? createTestTranscript();
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
    paneId: "single",
    sessionKey,
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
    onDraftChange: () => undefined,
    onSend: () => undefined,
    onToggleRealtimeTalk: () => undefined,
    onToggleRealtimeCamera: () => undefined,
    onDismissError: () => undefined,
    onAbort: () => undefined,
    onQueueRemove: () => undefined,
    onQueueSteer: () => undefined,
    agentsList: null,
    currentAgentId: "main",
    onSessionSelect: () => undefined,
    onOpenSidebar: () => undefined,
    onChatScroll: () => undefined,
    basePath: "",
    ...overrides,
    transcript,
  };
}

export function renderChatView(overrides: Partial<ChatProps> = {}) {
  const container = createComposerContainer();
  renderChatInto(container, overrides);
  return container;
}

const renderedTranscripts = new WeakMap<HTMLElement, ChatTranscript>();
const mountedViews = new WeakMap<
  HTMLElement,
  { update: (props: ChatProps, application?: ApplicationContext) => void; unmount: () => void }
>();

export function disposeChatView(container: HTMLElement) {
  mountedViews.get(container)?.unmount();
  mountedViews.delete(container);
  renderedTranscripts.get(container)?.dispose();
  renderedTranscripts.delete(container);
}

export function renderChatPropsInto(
  container: HTMLElement,
  props: ChatProps,
  application?: ApplicationContext,
) {
  const previous = renderedTranscripts.get(container);
  if (!previous) {
    const attached = !container.parentNode;
    if (attached) {
      document.body.append(container);
    }
    const [current, setCurrent] = createSignal({ props, application });
    const view = mountSolid(
      () => {
        const questions = createComposerQuestions(props.paneId, () => current().props);
        return createComponent(ChatView, {
          questions,
          get props() {
            return current().props;
          },
          get application() {
            const value = current().application;
            return value && normalizeApplicationContext(value);
          },
        });
      },
      { container, wrapper: composerContextWrapper(container) },
    );
    mountedViews.set(container, {
      update: (nextProps, nextApplication) =>
        setCurrent({ props: nextProps, application: nextApplication }),
      unmount: view.unmount,
    });
    onTestFinished(() => {
      disposeChatView(container);
      if (attached) {
        container.remove();
      }
    });
  } else if (previous !== props.transcript) {
    previous.dispose();
  }
  renderedTranscripts.set(container, props.transcript);
  if (previous) {
    mountedViews.get(container)?.update(props, application);
  }
  flush();
  props.transcript.start();
  props.transcript.update();
  flush();
}

export function renderChatInto(container: HTMLElement, overrides: Partial<ChatProps> = {}) {
  renderChatPropsInto(
    container,
    createChatProps({
      ...overrides,
      transcript: overrides.transcript ?? renderedTranscripts.get(container),
    }),
  );
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

function openThinkingPicker(container: Element): void {
  const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__effort-picker");
  if (picker && !picker.open) {
    picker.open = true;
    picker.dispatchEvent(new Event("toggle"));
    flush();
  }
}

export function getThinkingSlider(container: Element): HTMLInputElement | null {
  openThinkingPicker(container);
  return container.querySelector<HTMLInputElement>('[data-chat-thinking-slider="true"]');
}

export function getThinkingSliderValues(container: Element): string[] {
  const values = getThinkingSlider(container)?.dataset.chatThinkingValues ?? "";
  return values ? values.split(",") : [];
}

export function getThinkingReasoningValueLabel(container: Element): string {
  openThinkingPicker(container);
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

// Separate user gestures run in separate browser tasks, after Solid has settled.
export function inputDraft(container: HTMLElement, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
  expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
  textarea!.value = value;
  textarea!.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

export function inputDraftAtEnd(container: HTMLElement, value: string) {
  const textarea = getComposerTextarea(container);
  textarea.value = value;
  textarea.setSelectionRange(value.length, value.length);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  flush();
}

export function keydownComposer(container: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
  expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
  const event = new KeyboardEvent("keydown", { ...init, key, bubbles: true, cancelable: true });
  textarea!.dispatchEvent(event);
  flush();
  return event;
}

export function createReactiveDraftHarness({
  onDraftChange: observeDraftChange,
  ...overrides
}: Partial<ChatProps> = {}) {
  let draft = "";
  let currentOverrides = overrides;
  let active = true;
  const container = createComposerContainer();
  const draftSource = createComposerDraftSource(() => ({
    draft: currentOverrides.getDraft?.() ?? draft,
    mentions: currentOverrides.getMentions?.() ?? currentOverrides.mentions ?? [],
    attachments: currentOverrides.getAttachments?.() ?? currentOverrides.attachments ?? [],
    pendingAttachmentReads:
      currentOverrides.getPendingAttachmentReads?.() ??
      currentOverrides.pendingAttachmentReads ??
      0,
    goalDraftMode: currentOverrides.goalDraftMode,
  }));
  onTestFinished(() => {
    active = false;
    disposeChatView(container);
  });
  const onDraftChange = vi.fn((next: string) => {
    draft = next;
    observeDraftChange?.(next);
    draftSource.publish();
  });
  const renderCurrent = (nextOverrides: Partial<ChatProps> = {}) => {
    if (!active) {
      return;
    }
    currentOverrides = { ...currentOverrides, ...nextOverrides };
    draftSource.publish();
    renderChatInto(container, {
      draft,
      getDraft: () => draft,
      onDraftChange,
      ...currentOverrides,
      draftSource: currentOverrides.draftSource ?? draftSource,
      onGoalDraftModeChange: (mode) => {
        currentOverrides.onGoalDraftModeChange?.(mode);
        currentOverrides = { ...currentOverrides, goalDraftMode: mode };
        draftSource.publish();
      },
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

export function createReplyPane(paneId: string, draft: string, quote: string) {
  const container = createComposerContainer();
  const host: Pick<ChatProps, "draft" | "replyTarget"> = {
    draft,
    replyTarget: { messageId: `${paneId}-message`, text: quote, senderLabel: "User" },
  };
  const onSend = vi.fn();
  const onAbort = vi.fn();
  const onDraftChange = vi.fn((next: string) => {
    host.draft = next;
  });
  const onClearReply = vi.fn(() => {
    host.replyTarget = null;
    redraw();
  });
  const redraw = vi.fn(() => {
    renderChatInto(container, {
      paneId,
      sessionKey: `agent:main:${paneId}`,
      draft: host.draft,
      getDraft: () => host.draft,
      replyTarget: host.replyTarget,
      canAbort: true,
      runActive: true,
      onDraftChange,
      onClearReply,
      onSend,
      onAbort,
    });
  });
  return {
    container,
    host,
    redraw,
    onDraftChange,
    onClearReply,
    onSend,
    onAbort,
    dispose: () => {
      disposeChatView(container);
      container.remove();
      resetChatViewState(paneId, container);
    },
  };
}

export function appendMessageActionFixture(
  group: HTMLElement,
  messageKey: string,
  onCopy?: () => void,
) {
  const element = document.createElement("div");
  element.dataset.messageActionsFor = messageKey;
  const copy = onCopy ? document.createElement("button") : undefined;
  if (copy) {
    copy.className = "chat-copy-btn";
    copy.addEventListener("click", () => onCopy?.());
    element.append(copy);
  }
  group.append(element);
  onTestFinished(registerMessageActionElements(element, () => messageKey, { copy }));
}
