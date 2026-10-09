/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import type { UiSettings } from "../../app/settings.ts";
import { i18n, t } from "../../i18n/index.ts";
import type { ChatAttachment, ChatQueueItem, MessageGroup } from "../../lib/chat/chat-types.ts";
import { buildFallbackSlashCommands, replaceSlashCommands } from "../../lib/chat/commands.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import type {
  SessionPatchOptions,
  SessionPatchResult,
  SessionPatchRoute,
} from "../../lib/sessions/patch.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import {
  createModelCatalog,
  createSessionsListResult,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "../../test-helpers/chat-model.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload as registerStoredChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import {
  getAttachmentMenuOption,
  renderAttachmentHarness,
  requireAttachmentInput,
  selectAttachmentMenuOption,
  selectFile,
} from "./chat-attachment-picker.test-support.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createChatModelSetupBanner } from "./chat-model-setup.ts";
import { applyChatPendingInputs, getChatPendingInputs } from "./chat-pending-inputs.ts";
import * as chatProgress from "./chat-progress.ts";
import { switchChatFastMode, switchChatModel, switchChatThinkingLevel } from "./chat-session.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import * as chatThread from "./chat-thread.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import {
  appendChatBubble,
  replaceSkillCommands,
  inputDraft,
  inputDraftAtEnd,
  keydownComposer,
  createReactiveDraftHarness,
  createSlashRerenderHarness,
  createChatProps,
  createPasteEvent,
  createTestTranscript,
  renderChatInto,
  renderChatView,
  getComposerTextarea,
  requireElement,
  stubAnimationFrames,
  createDragEvent,
  getChatModelSelect,
  getChatThinkingValue,
  getThinkingReasoningValueLabel,
  getThinkingSelect,
  getThinkingSlider,
  getThinkingSliderValues,
  itemAt,
} from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
import * as chatMessageConfirmation from "./components/chat-message-confirmation.ts";
import * as chatMessage from "./components/chat-message-group.ts";
import * as chatMessageStream from "./components/chat-message-stream.ts";
import { renderChatModelAccountControl } from "./components/chat-model-account-control.ts";
import { renderChatModelControls } from "./components/chat-model-controls.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";
import {
  resetThreadPresentation,
  resetTranscriptSession,
  toggleTranscriptSearch,
} from "./components/chat-thread-interactions.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { renderWelcomeState } from "./components/chat-welcome.ts";
import { RealtimeTalkLevelSignal } from "./talk/level.ts";
import {
  workspaceConflictPathForDisplay,
  workspaceResultConflictFromTranscript,
} from "./workspace-conflict.ts";

const registeredAttachmentPayloads = new Map<
  string,
  ReturnType<typeof registerStoredChatAttachmentPayload>
>();

function registerChatAttachmentPayload(
  params: Parameters<typeof registerStoredChatAttachmentPayload>[0],
) {
  const attachment = registerStoredChatAttachmentPayload(params);
  registeredAttachmentPayloads.set(attachment.id, attachment);
  return attachment;
}

function visibleContentForMessages(messages: unknown[]): MessageGroup["visibleContent"] {
  const groups = groupMessages(
    messages.map((message, index) => ({ kind: "message", key: `message:${index}`, message })),
  );
  if (groups.some((group) => group.kind === "group" && group.visibleContent === "non-text")) {
    return "non-text";
  }
  return groups.some((group) => group.kind === "group" && group.visibleContent === "text")
    ? "text"
    : "none";
}

function createMessageEntry(key: string, message: unknown): MessageGroup["messages"][number] {
  const [group] = groupMessages([{ kind: "message", key, message }]);
  if (group?.kind !== "group") {
    throw new Error("expected a prepared message group");
  }
  return expectDefined(group.messages[0], "Prepared message entry");
}

const buildChatItemsMock = vi.fn(
  (props: {
    messages: unknown[];
    stream: string | null;
    streamStartedAt: number | null;
    runWorking?: boolean;
    loading?: boolean;
  }): ReturnType<typeof chatThread.buildCachedChatItems> => {
    const items: unknown[] = [];
    if (props.messages.length > 0) {
      const virtualRows = props.messages.every(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { testVirtualRow?: unknown }).testVirtualRow === true,
      );
      if (virtualRows) {
        items.push(
          ...props.messages.map((message, index) => {
            const testMessage = message as {
              testVirtualKey?: string;
              testVirtualRole?: string;
            };
            const key = testMessage.testVirtualKey ?? String(index);
            return {
              kind: "group",
              key: `group:${key}`,
              role: testMessage.testVirtualRole ?? (index % 2 === 0 ? "user" : "assistant"),
              messages: [createMessageEntry(`message:${key}`, message)],
              visibleContent: visibleContentForMessages([message]),
              timestamp: index + 1,
              isStreaming: false,
            };
          }),
        );
      } else {
        items.push({
          kind: "group",
          key: "group:assistant:test",
          role: "assistant",
          runId: (props.messages.at(-1) as { runId?: string } | undefined)?.runId,
          messages: props.messages.map((message, index) =>
            createMessageEntry(`message:${index}`, message),
          ),
          visibleContent: visibleContentForMessages(props.messages),
          timestamp: 1,
          isStreaming: false,
        });
      }
    }
    // Mirrors buildChatItems: streamed text renders as a stream item; an
    // empty stream or a working run with no stream shows the reading
    // indicator (working spark), except on the initial empty load where
    // the skeleton owns the thread.
    if (props.stream !== null) {
      items.push(
        props.stream
          ? {
              kind: "stream",
              key: "stream:test",
              text: props.stream,
              startedAt: props.streamStartedAt ?? 1,
              isStreaming: true,
            }
          : {
              kind: "reading-indicator",
              key: "reading:test",
              startedAt: props.streamStartedAt ?? 1,
            },
      );
    } else if (
      props.runWorking === true &&
      !(props.loading === true && props.messages.length === 0)
    ) {
      items.push({
        kind: "reading-indicator",
        key: "reading:test",
        startedAt: props.streamStartedAt ?? 1,
      });
    }
    return items as ReturnType<typeof chatThread.buildCachedChatItems>;
  },
);
const renderMessageGroupMock = vi.fn<typeof chatMessage.renderMessageGroup>((group) => {
  const text = group.messages
    .map(({ message }) => {
      if (typeof message === "object" && message !== null && "content" in message) {
        const content = (message as { content?: unknown }).content;
        if (typeof content === "string") {
          return content;
        }
        return content == null ? "" : JSON.stringify(content);
      }
      return String(message);
    })
    .join("\n");
  return html`<div class="chat-group">${text}</div>`;
});

type ChatHeaderTestState = {
  basePath?: string;
  chatLoading: boolean;
  chatMessage: string;
  chatMessages: unknown[];
  chatModelCatalog: ModelCatalogEntry[];
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatSending: boolean;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatThinkingLevel: string | null;
  chatVerboseLevel: string | null;
  chatAvatarUrl: string | null;
  client: GatewayBrowserClient;
  connected: boolean;
  hello: GatewayHelloOk | null;
  lastError: string | null;
  modelAuthStatusResult?: ModelAuthStatusResult | null;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
  agentsList: null;
  agentsPanel: string;
  agentsSelectedId: string | null;
  settings: UiSettings;
  sessions: SessionCapability;
  setRoute: ReturnType<typeof vi.fn>;
  toolsEffectiveLoading: boolean;
  toolsEffectiveLoadingKey: string | null;
  toolsEffectiveError: string | null;
  toolsEffectiveResultKey: string | null;
  toolsEffectiveResult: unknown;
  applySettings(patch: Partial<UiSettings>): void;
  loadAssistantIdentity(): void;
  resetChatInputHistoryNavigation(): void;
  resetChatScroll(): void;
  resetToolStream(): void;
};

type ChatProps = Parameters<typeof renderChat>[0];

function createOpenAiModelCatalog(): ModelCatalogEntry[] {
  return [
    { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
    { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
  ];
}

function requireFirstAttachmentsChange(
  onAttachmentsChange: ReturnType<typeof vi.fn>,
): ChatAttachment[] {
  const [call] = onAttachmentsChange.mock.calls;
  if (!call) {
    throw new Error("expected attachments change call");
  }
  const [attachments] = call;
  if (!Array.isArray(attachments)) {
    throw new Error("expected attachments array");
  }
  return attachments as ChatAttachment[];
}

const renderStreamGroupMock: typeof chatMessageStream.renderStreamGroup = (parts) =>
  html`<div class="chat-stream-run">
    ${parts.map((part) =>
      part.kind === "reading-indicator"
        ? html`<div class="chat-reading-indicator"></div>`
        : html`<div class="chat-stream">${part.kind === "stream" ? part.text : ""}</div>`,
    )}
  </div>`;

beforeEach(() => {
  onTestFinished(installChatComposerPickerDismissal(document));
  installTranscriptDomMocks();
  vi.spyOn(chatThread, "buildCachedChatItems").mockImplementation(buildChatItemsMock);
  vi.spyOn(chatThread, "getExpandedToolCards").mockReturnValue(new Map<string, boolean>());
  vi.spyOn(chatThread, "getExpandedUserMessages").mockReturnValue(new Map<string, boolean>());
  vi.spyOn(chatThread, "syncToolCardExpansionState").mockImplementation(() => undefined);
  vi.spyOn(chatMessage, "renderMessageGroup").mockImplementation(renderMessageGroupMock);
  vi.spyOn(chatMessageStream, "renderStreamGroup").mockImplementation(renderStreamGroupMock);
  vi.spyOn(chatMessageStream, "renderWorkGroupSummary").mockReturnValue(
    html`<div class="chat-work-group"></div>`,
  );
});

function createSessionsResultFromRows(sessions: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: sessions.length,
    defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
    sessions,
  };
}

function createSettingsLaneHost(
  patch: SessionPatchRoute,
  refresh: () => Promise<void> = async () => {},
) {
  const host = makeChatHost({
    requestHandlers: {},
    sessionKey: "main",
    chatModelSwitchPromises: {},
    chatThinkingLevel: "high",
    sessionsResult: createSessionsResultFromRows([
      {
        key: "main",
        agentId: "main",
        sessionId: "main",
        kind: "direct",
        updatedAt: 1,
        model: "claude-fable-5",
        modelProvider: "anthropic",
        thinkingLevel: "high",
        fastMode: false,
        effectiveFastMode: false,
      },
    ]),
  });
  vi.spyOn(host.sessions, "patch").mockImplementation(patch);
  vi.spyOn(host.sessions, "refresh").mockImplementation(refresh);
  onTestFinished(() => host.sessions.dispose());
  return host;
}

function createChatHeaderState(
  overrides: {
    model?: string | null;
    modelProvider?: string | null;
    modelOverrideSource?: GatewaySessionRow["modelOverrideSource"];
    models?: ModelCatalogEntry[];
    defaultsThinkingDefault?: string;
    thinkingDefault?: string;
    thinkingLevels?: GatewaySessionRow["thinkingLevels"];
    omitSessionFromList?: boolean;
  } = {},
): { state: ChatHeaderTestState; request: ReturnType<typeof vi.fn> } {
  let currentModel = overrides.model ?? null;
  let currentModelProvider = overrides.modelProvider ?? (currentModel ? "openai" : null);
  const omitSessionFromList = overrides.omitSessionFromList ?? false;
  const catalog = overrides.models ?? createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG);
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "sessions.patch") {
      if (Object.hasOwn(params, "model")) {
        const nextModel = (params.model as string | null | undefined) ?? null;
        if (!nextModel) {
          currentModel = null;
          currentModelProvider = null;
        } else {
          const normalized = nextModel.trim();
          const slashIndex = normalized.indexOf("/");
          if (slashIndex > 0) {
            currentModelProvider = normalized.slice(0, slashIndex);
            currentModel = normalized.slice(slashIndex + 1);
          } else {
            currentModel = normalized;
            const matchingProviders: string[] = [];
            for (const entry of catalog) {
              if (entry.id === normalized && entry.provider) {
                matchingProviders.push(entry.provider);
              }
            }
            currentModelProvider =
              matchingProviders.length === 1
                ? expectDefined(matchingProviders[0], "single matching model provider")
                : currentModelProvider;
          }
        }
      }
      return {
        ok: true,
        path: "",
        key: "main",
        entry: { sessionId: "main" },
      } satisfies SessionPatchResult;
    }
    if (method === "chat.history") {
      return { messages: [], thinkingLevel: null };
    }
    if (method === "sessions.list") {
      return createSessionsListResult({
        model: currentModel,
        modelProvider: currentModelProvider,
        modelOverrideSource: overrides.modelOverrideSource,
        defaultsThinkingDefault: overrides.defaultsThinkingDefault,
        thinkingDefault: overrides.thinkingDefault,
        thinkingLevels: overrides.thinkingLevels,
        omitSessionFromList,
      });
    }
    if (method === "models.list") {
      return { models: catalog };
    }
    if (method === "tools.effective") {
      return {
        agentId: "main",
        profile: "coding",
        groups: [],
      };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const sessions = createTestSessionCapability({
    snapshot: { client, phase: "connected", hello: sessionMutationGatewayHello() },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
  const initialSessionsResult = createSessionsListResult({
    model: currentModel,
    modelProvider: currentModelProvider,
    modelOverrideSource: overrides.modelOverrideSource,
    defaultsThinkingDefault: overrides.defaultsThinkingDefault,
    thinkingDefault: overrides.thinkingDefault,
    thinkingLevels: overrides.thinkingLevels,
    omitSessionFromList,
  });
  const state: ChatHeaderTestState = {
    sessionKey: "main",
    connected: true,
    sessionsResult: initialSessionsResult,
    chatModelCatalog: catalog,
    client,
    settings: {
      gatewayUrl: "",
      token: "",
      locale: "en",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "dark",
      navCollapsed: false,
      navWidth: 280,
      sidebarEntries: [],
      chatShowThinking: false,
      chatShowToolCalls: true,
    },
    chatMessage: "",
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunId: null,
    chatQueue: [],
    chatMessages: [],
    chatLoading: false,
    chatSending: false,
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    lastError: null,
    chatAvatarUrl: null,
    basePath: "",
    hello: sessionMutationGatewayHello(),
    agentsList: null,
    agentsPanel: "overview",
    agentsSelectedId: null,
    sessions,
    toolsEffectiveLoading: false,
    toolsEffectiveLoadingKey: null,
    toolsEffectiveResultKey: null,
    toolsEffectiveError: null,
    toolsEffectiveResult: null,
    applySettings(patch: Partial<UiSettings>) {
      state.settings = { ...state.settings, ...patch };
    },
    setRoute: vi.fn(),
    loadAssistantIdentity: vi.fn(),
    resetChatInputHistoryNavigation: vi.fn(),
    resetToolStream: vi.fn(),
    resetChatScroll: vi.fn(),
  };
  sessions.subscribe((next) => {
    state.sessionsResult = next.result;
  });
  return { state, request };
}

function createReasoningHeaderState(options: { models: ModelCatalogEntry[] }) {
  const result = createChatHeaderState({
    model: "gpt-5.5",
    modelProvider: "openai",
    models: options.models,
    thinkingDefault: "high",
  });
  result.state.sessionsResult = createSessionsListResult({
    defaultsModel: "gpt-5.5",
    defaultsProvider: "openai",
    defaultsThinkingDefault: "high",
    defaultsThinkingLevels: [
      { id: "low", label: "low" },
      { id: "high", label: "high" },
    ],
  });
  return result;
}

type ChatModelControlsProps = Parameters<typeof renderChatModelControls>[0];

function createChatModelControlsProps(state: ChatHeaderTestState): ChatModelControlsProps {
  const selectedSession = state.sessionsResult?.sessions.find((row) =>
    areUiSessionKeysEquivalent(row.key, state.sessionKey),
  );
  return {
    activeRunId: state.chatRunId,
    activeRunSessionKey: state.chatRunId ? state.sessionKey : undefined,
    connected: state.connected,
    gatewayAvailable: Boolean(state.client),
    loading: state.chatLoading,
    modelCatalog: state.chatModelCatalog,
    modelCatalogState: { hasSnapshot: true, status: "ready" },
    modelOverrides: state.sessions.state.modelOverrides,
    modelSelectionLocked: selectedSession?.modelSelectionLocked,
    modelSelectionTarget: state.sessionsResult?.defaults.modelSelectionTarget,
    modelSwitching: false,
    sending: state.chatSending,
    sessionKey: state.sessionKey,
    selectedSession,
    sessionsResult: state.sessionsResult,
    stream: state.chatStream,
    onFastModeSelect: (value, targetSessionKey) =>
      switchChatFastMode(
        state as unknown as Parameters<typeof switchChatFastMode>[0],
        value,
        targetSessionKey,
      ),
    onModelSelect: (value, targetSessionKey, agentRuntime) =>
      switchChatModel(
        state as unknown as Parameters<typeof switchChatModel>[0],
        value,
        targetSessionKey,
        agentRuntime,
      ),
    onThinkingSelect: (value, targetSessionKey) =>
      switchChatThinkingLevel(
        state as unknown as Parameters<typeof switchChatThinkingLevel>[0],
        value,
        targetSessionKey,
      ),
  };
}

function renderModelControls(
  state: ChatHeaderTestState,
  overrides: Partial<ChatModelControlsProps> = {},
  container = document.createElement("div"),
) {
  render(
    renderChatModelControls({ ...createChatModelControlsProps(state), ...overrides }),
    container,
  );
  return container;
}

describe("chat typing status", () => {
  it.each([
    {
      actors: [{ id: "ayaan", label: "Ayaan" }],
      expectedText: "Ayaan is typing…",
      expectedAvatars: 1,
    },
    {
      actors: [
        { id: "ayaan", label: "Ayaan" },
        { id: "liam", label: "Liam" },
        { id: "maya", label: "Maya" },
        { id: "zoe", label: "Zoe" },
      ],
      expectedText: "Ayaan, Liam, Maya, Zoe are typing…",
      expectedAvatars: 4,
    },
  ])("renders $expectedText in the transcript", ({ actors, expectedText, expectedAvatars }) => {
    const container = renderChatView({ typingActors: actors });
    const indicator = container.querySelector(".agent-chat__typing-indicator--outside");

    expect(indicator?.closest('[data-virtual-row-key="presence:typing"]')).not.toBeNull();
    expect(indicator?.closest(".agent-chat__composer-shell")).toBeNull();
    expect(indicator?.querySelectorAll("[role=img]")).toHaveLength(expectedAvatars);
    expect(indicator?.querySelectorAll(".agent-chat__typing-state")).toHaveLength(
      Math.min(2, actors.length),
    );
    expect(
      indicator?.querySelector(".agent-chat__typing-bubble")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(indicator?.textContent).toContain(expectedText);
  });
});

describe("chat run error", () => {
  it("keeps Check delivery reachable when exact history deduplicates the retained bubble", () => {
    vi.mocked(chatThread.buildCachedChatItems).mockRestore();
    vi.mocked(chatMessage.renderMessageGroup).mockRestore();
    const onRetrySessionPlacementStartup = vi.fn();
    const container = renderChatView({
      canSend: false,
      messages: [
        {
          role: "user",
          content: "original prompt",
          __openclaw: { idempotencyKey: "initial:user" },
        },
      ],
      placementStartup: {
        sessionKey: "main",
        targetKind: "profile",
        phase: "failed",
        startedAt: 1,
        retryable: true,
        action: "check-delivery",
        initialTurn: {
          id: "initial",
          sendRunId: "initial",
          text: "original prompt",
          createdAt: 1,
          sendAttempts: 1,
          sendState: "unconfirmed",
        },
      },
      onRetrySessionPlacementStartup,
    });
    expect(container.querySelectorAll(".chat-group.user")).toHaveLength(1);
    expect(container.querySelector(".chat-send-status__retry")).toBeNull();
    const action = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".chat-error button"),
    ).find((button) => button.textContent?.trim() === "Check delivery");
    expect(action).toBeDefined();
    action?.click();
    expect(onRetrySessionPlacementStartup).toHaveBeenCalledOnce();
  });

  it.each(["retry", "check-delivery"] as const)(
    "keeps the retained initial turn's %s action usable while ordinary sending is held",
    (action) => {
      vi.mocked(chatThread.buildCachedChatItems).mockRestore();
      vi.mocked(chatMessage.renderMessageGroup).mockRestore();
      const onRetrySessionPlacementStartup = vi.fn();
      const onQueueRetry = vi.fn();
      const container = renderChatView({
        canSend: false,
        messages: [
          { role: "user", content: "[System] Gateway restarted", timestamp: 3 },
          { role: "assistant", content: "Worker recovery is pending", timestamp: 4 },
        ],
        queue: [
          {
            id: "ordinary",
            text: "later draft",
            createdAt: 2,
            sendAttempts: 1,
            sendState: "failed",
          },
        ],
        placementStartup: {
          sessionKey: "agent:main:startup",
          targetKind: "profile",
          phase: "failed",
          startedAt: 1,
          retryable: true,
          action,
          error: "Retained initial turn",
          initialTurn: {
            id: "initial",
            sendRunId: "initial",
            text: "original prompt",
            createdAt: 1,
            sendAttempts: 1,
            sendState: action === "retry" ? "failed" : "unconfirmed",
          },
        },
        onRetrySessionPlacementStartup,
        onQueueRetry,
      });
      expect(container.querySelector(".chat-thread")?.textContent).toContain("original prompt");
      expect(container.querySelector(".chat-thread")?.textContent).toContain("later draft");
      const transcript = container.querySelector(".chat-thread")?.textContent ?? "";
      expect(transcript.indexOf("original prompt")).toBeLessThan(
        transcript.indexOf("Gateway restarted"),
      );
      expect(transcript.indexOf("Worker recovery is pending")).toBeLessThan(
        transcript.indexOf("later draft"),
      );
      const buttons = container.querySelectorAll<HTMLButtonElement>(".chat-send-status__retry");
      expect(buttons).toHaveLength(1);
      expect(buttons[0]?.textContent?.trim()).toBe(action === "retry" ? "Retry" : "Check delivery");
      buttons[0]?.click();
      expect(onRetrySessionPlacementStartup).toHaveBeenCalledOnce();
      expect(onQueueRetry).not.toHaveBeenCalled();
      expect(container.querySelector(".chat-error")?.textContent).toContain(
        action === "retry" ? "Retained initial turn" : "without resending it or starting a worker",
      );
    },
  );

  it.each(["run", "request"])(
    "strips only the decorative prefix from a %s error display and copies the raw diagnostic",
    async (source) => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const diagnostic =
        "⚠️ 🛠️ Error:  gateway disconnected near 🧭\n  indented\tdetail\n<img src=x onerror=alert(1)>\nFinal diagnostic line  ";
      const renderedDiagnostic =
        "  Error:  gateway disconnected near 🧭\n  indented\tdetail\n<img src=x onerror=alert(1)>\nFinal diagnostic line  ";
      const onDismissError = vi.fn();
      const onRetrySessionPlacementStartup = vi.fn();
      const container = renderChatView({
        ...(source === "run" ? { runError: { summary: diagnostic } } : { error: diagnostic }),
        onDismissError,
        onRetrySessionPlacementStartup,
      });

      const alert = requireElement(container, ".chat-error", "chat run error");
      expect(alert.getAttribute("role")).toBe("alert");
      const details = requireElement(alert, "details", "error disclosure");
      expect(details.hasAttribute("open")).toBe(false);
      const fullDiagnostic = requireElement(details, "pre", "full diagnostic");
      expect(fullDiagnostic.textContent).toBe(renderedDiagnostic);
      expect(fullDiagnostic.getAttribute("aria-label")).toBe("Error details");
      expect(alert.textContent).not.toMatch(/[⚠🛠]/u);
      expect(alert.textContent).toContain("🧭");
      expect(alert.querySelector("img")).toBeNull();
      const summary = requireElement(details, "summary", "error header");
      expect(summary.textContent).toContain("Details");
      expect(summary.textContent).not.toContain("Error details");
      expect(alert.querySelectorAll(".chat-copy-btn")).toHaveLength(1);
      const copy = summary.querySelector<HTMLButtonElement>('[aria-label="Copy error"]');
      expect(copy).not.toBeNull();
      for (const open of [false, true]) {
        details.toggleAttribute("open", open);
        copy?.click();
        await waitForFast(() => expect(copy?.disabled).toBe(false));
        await waitForFast(() => expect(writeText).toHaveBeenCalledTimes(open ? 2 : 1));
        expect(writeText).toHaveBeenLastCalledWith(diagnostic);
        expect(details.hasAttribute("open")).toBe(open);
      }
      (summary as HTMLElement).click();
      expect(onDismissError).not.toHaveBeenCalled();
      expect(onRetrySessionPlacementStartup).not.toHaveBeenCalled();
      expect(alert.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]') !== null).toBe(
        source === "request",
      );
      expect(
        alert.closest(source === "run" ? ".agent-chat__composer-notices" : ".chat-topbar-notices"),
      ).not.toBeNull();
      alert.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')?.click();
      expect(onDismissError).toHaveBeenCalledTimes(source === "request" ? 1 : 0);
    },
  );

  it.each([true])("keeps startup Retry owned by retryable=%s", async (retryable) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onRetrySessionPlacementStartup = vi.fn();
    const container = renderChatView({
      placementStartup: {
        sessionKey: "agent:main:startup",
        targetKind: "profile",
        phase: "failed",
        startedAt: 1,
        error: "⚠️ Provisioning failed\n  Final diagnostic line  ",
        retryable,
      },
      onRetrySessionPlacementStartup,
    });
    const alert = requireElement(container, ".chat-error", "startup error");
    expect(requireElement(alert, "pre", "startup diagnostic").textContent).toBe(
      "The session was created, but startup needs attention:  Provisioning failed\n  Final diagnostic line  ",
    );
    expect(alert.textContent).not.toContain("⚠");
    const details = requireElement(alert, "details", "startup disclosure");
    expect(requireElement(details, "summary", "startup header").textContent).toContain("Details");
    expect(requireElement(details, "pre", "startup diagnostic").getAttribute("aria-label")).toBe(
      "Error details",
    );
    const copy = details.querySelector<HTMLButtonElement>('summary [aria-label="Copy error"]');
    expect(copy).not.toBeNull();
    copy?.click();
    await waitForFast(() =>
      expect(writeText).toHaveBeenCalledWith(
        "The session was created, but startup needs attention: ⚠️ Provisioning failed\n  Final diagnostic line  ",
      ),
    );
    expect(details.hasAttribute("open")).toBe(false);
    alert.querySelector<HTMLElement>("summary")?.click();
    expect(onRetrySessionPlacementStartup).not.toHaveBeenCalled();
    const retry = Array.from(alert.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Retry",
    );
    expect(Boolean(retry)).toBe(retryable);
    retry?.click();
    expect(onRetrySessionPlacementStartup).toHaveBeenCalledTimes(retryable ? 1 : 0);
  });
});

describe("cloud workspace conflict notice", () => {
  const conflict = {
    paths: [
      "src/[path]-1.ts",
      "src/path-2.ts",
      "src/path-3.ts",
      "src/path-4.ts",
      "src/path-5.ts",
      "src/path-6.ts",
    ],
    stagedResultRef: "refs/openclaw/worker-results/claim-123",
    totalCount: 9,
  };

  it("bounds conflict guidance and copies the selected path recovery command", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onDismissWorkspaceConflict = vi.fn();
    const container = renderChatView({
      workspaceConflict: conflict,
      onDismissWorkspaceConflict,
    });

    const notice = requireElement(
      container,
      ".chat-workspace-conflict-notice",
      "workspace conflict notice",
    );
    expect(notice.closest(".agent-chat__composer-notices")).not.toBeNull();
    expect(notice.textContent).toContain("9 cloud workspace conflicts");
    expect(notice.querySelectorAll(".chat-workspace-conflict-paths li")).toHaveLength(5);
    expect(notice.textContent).toContain("+4 more paths");
    expect(notice.textContent).toContain(conflict.stagedResultRef);
    expect(notice.textContent).toContain("Git Bash on Windows");
    expect(notice.textContent).toContain("file/directory conflict");
    expect(notice.textContent).toContain("cloud deleted it");
    expect(notice.textContent).toContain("staged ref is missing");

    const commands = [...notice.querySelectorAll(".chat-workspace-conflict-commands code")].map(
      (element) => element.textContent,
    );
    expect(commands).toEqual([
      "git show 'refs/openclaw/worker-results/claim-123:src/[path]-1.ts'",
      "git checkout 'refs/openclaw/worker-results/claim-123' -- ':(top,literal)src/[path]-1.ts'",
    ]);
    expect(
      notice.querySelector<HTMLButtonElement>('[aria-label="Copy cloud inspect command"]'),
    ).toBeInstanceOf(HTMLButtonElement);
    expect(
      notice.querySelector<HTMLButtonElement>('[aria-label="Copy take-cloud command"]'),
    ).toBeInstanceOf(HTMLButtonElement);

    const rows = notice.querySelectorAll(".chat-workspace-conflict-paths li");
    rows[1]?.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(
      "git checkout 'refs/openclaw/worker-results/claim-123' -- ':(top,literal)src/path-2.ts'",
    );

    notice
      .querySelector<HTMLButtonElement>('[aria-label="Dismiss workspace conflict notice"]')!
      .click();
    expect(onDismissWorkspaceConflict).toHaveBeenCalledTimes(1);
  });

  it.each(["\u0085"])(
    "keeps terminal-control paths visible without building copyable commands (%j)",
    (controlSequence) => {
      const entryPath = `src/${controlSequence}unsafe.ts`;
      const normalizedConflict = workspaceResultConflictFromTranscript({
        role: "custom",
        customType: "cloud-workspace-conflict",
        details: {
          paths: [entryPath],
          stagedResultRef: "refs/openclaw/worker-results/claim-unsafe",
        },
      });
      expect(normalizedConflict).toBeDefined();
      const container = renderChatView({ workspaceConflict: normalizedConflict });
      expect(container.querySelector(".chat-workspace-conflict-paths code")?.textContent).toBe(
        workspaceConflictPathForDisplay(entryPath),
      );
      expect(container.querySelector(".chat-workspace-conflict-commands")).toBeNull();
      expect(container.textContent).toContain("will not build a copyable shell command");
    },
  );
});

describe("cloud worker disk-space notice", () => {
  it("updates persistent disk guidance and clears it after recovery", () => {
    const container = document.createElement("div");
    renderChatInto(container, {
      diskSpace: { status: "warning", availableBytes: 400, totalBytes: 1_000, observedAtMs: 1 },
    });
    expect(container.querySelector(".chat-cloud-disk-space-notice")).not.toBeNull();
    renderChatInto(container, {
      diskSpace: {
        status: "critical",
        availableBytes: 50 * 1024 * 1024,
        totalBytes: 10 * 1024 * 1024 * 1024,
        observedAtMs: 1_000,
      },
    });
    const notice = requireElement(container, ".chat-cloud-disk-space-notice", "disk-space notice");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("Cloud session disk space is critically low");
    expect(notice.textContent).toContain("New writes may fail and stop the agent.");
    expect(notice.querySelector("svg")).not.toBeNull();
    expect(notice.querySelector("button")).toBeNull();
    expect(notice.closest(".chat-topbar-notices")).not.toBeNull();
    renderChatInto(container, {
      diskSpace: { status: "ok", availableBytes: 800, totalBytes: 1_000, observedAtMs: 2 },
    });
    expect(container.querySelector(".chat-cloud-disk-space-notice")).toBeNull();
  });
});

describe("chat history pagination", () => {
  it("keeps earlier history discoverable and retryable until the transcript is exhausted", () => {
    const onShowEarlier = vi.fn();
    const container = document.createElement("div");
    renderChatInto(container, {
      historyPagination: { hasMore: true, loading: false, onShowEarlier },
    });

    const button = requireElement(
      container,
      ".chat-history-boundary__action",
      "earlier history action",
    ) as HTMLButtonElement;
    expect(button.textContent).toContain("Show earlier");
    expect(button.getAttribute("aria-label")).toBe("Show earlier");
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(button.disabled).toBe(false);
    expect(button.closest(".chat-thread")).not.toBeNull();
    button.click();
    expect(onShowEarlier).toHaveBeenCalledOnce();

    renderChatInto(container, {
      historyPagination: { hasMore: true, loading: true, onShowEarlier },
    });
    const loadingButton = requireElement(
      container,
      ".chat-history-boundary__action",
      "loading earlier history action",
    ) as HTMLButtonElement;
    expect(loadingButton.textContent?.trim()).toBe("Loading earlier…");
    expect(loadingButton.getAttribute("aria-label")).toBe("Loading earlier…");
    expect(loadingButton.getAttribute("aria-busy")).toBe("true");
    expect(loadingButton.disabled).toBe(true);
    expect(loadingButton.closest(".chat-history-boundary--loading")).not.toBeNull();
    loadingButton.click();
    expect(onShowEarlier).toHaveBeenCalledOnce();

    renderChatInto(container, {
      historyPagination: { hasMore: true, loading: false, onShowEarlier },
    });
    const retryButton = requireElement(
      container,
      ".chat-history-boundary__action",
      "retry earlier history action",
    ) as HTMLButtonElement;
    expect(retryButton.textContent?.trim()).toBe("Show earlier");
    expect(retryButton.getAttribute("aria-label")).toBe("Show earlier");
    expect(retryButton.getAttribute("aria-busy")).toBe("false");
    expect(retryButton.disabled).toBe(false);
    retryButton.click();
    expect(onShowEarlier).toHaveBeenCalledTimes(2);

    renderChatInto(container);
    expect(container.querySelector(".chat-history-boundary")).toBeNull();
    expect(container.querySelector(".chat-history-sentinel")).toBeNull();
  });

  it("loads older history from upward wheel and keyboard intent without a button", () => {
    const onHistoryIntent = vi.fn();
    const container = renderChatView({
      historyPagination: {
        hasMore: true,
        loading: false,
        onShowEarlier: vi.fn(),
      },
      onHistoryIntent,
    });
    const thread = requireElement(container, ".chat-thread", "chat thread");
    const sentinel = requireElement(container, ".chat-history-sentinel", "history sentinel");

    expect(sentinel.querySelector("button")).toBeNull();
    thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
    thread.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    expect(onHistoryIntent).toHaveBeenCalledTimes(2);
  });
});

describe("retained input navigation", () => {
  it.each([
    {
      type: "attachment",
      attachment: { kind: "document", label: "installation.pdf", url: "/media/installation.pdf" },
    },
    {
      type: "attachment_error",
      attachment: { kind: "video", label: "walkthrough.mp4", code: "file-not-found" },
    },
  ])("names a queued $attachment.kind attachment without message text", (content) => {
    const historyState = makeChatHost({ currentSessionId: "attachment-session" });
    applyChatPendingInputs(historyState, {
      total: 1,
      items: [
        {
          id: "attachment-input",
          runId: "attachment-run",
          acceptedAt: 1,
          state: "queued",
          queued: true,
          message: { role: "user", content: [content] },
        },
      ],
    });
    const container = renderChatView({ historyState });
    expect(container.querySelector(".chat-queue__text")?.textContent).toBe(
      content.attachment.label,
    );
    expect(container.querySelector(".chat-group.user")).toBeNull();
  });

  it("keeps an empty filtered page navigable without blocking an independent send", async () => {
    const sessionKey = "agent:main:hidden-page";
    const sessionId = "hidden-page-session";
    const olderPage = {
      total: 21,
      items: [
        {
          id: "older-visible",
          acceptedAt: 1,
          state: "interrupted" as const,
          message: { role: "user", content: "Older visible input" },
        },
      ],
    };
    const historyState = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: { "chat.history": () => ({ sessionId, pendingInputs: olderPage }) },
    });
    applyChatPendingInputs(historyState, { total: 21, items: [], nextBefore: 2 });
    const onSend = vi.fn();
    const container = renderChatView({
      historyState,
      sessionKey,
      draft: "Independent work",
      getDraft: () => "Independent work",
      onSend,
    });
    const earlier = expectDefined(
      [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes(t("chat.pendingInputs.earlier")),
      ),
      "earlier pending-input navigation",
    );
    expect(earlier.disabled).toBe(false);
    const send = expectDefined(
      container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
      "send button",
    );
    expect(send.disabled).toBe(false);
    send.click();
    expect(onSend).toHaveBeenCalledOnce();
    earlier.click();
    await vi.waitFor(() => expect(getChatPendingInputs(historyState)?.page).toEqual(olderPage));
    expect(historyState.request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ pendingBefore: 2 }),
    );
    expect(historyState.chatMessages).toEqual([]);
  });

  it("hides the retained queue copy represented by pending custody without hiding an identical new send", () => {
    const historyState = makeChatHost({ currentSessionId: "retained-input-session" });
    const message = {
      role: "user",
      content: "Check the deployment notes",
      timestamp: 100,
      idempotencyKey: "retained-run:user",
    };
    applyChatPendingInputs(historyState, {
      total: 1,
      items: [
        {
          id: "retained-input",
          runId: "retained-run",
          acceptedAt: 100,
          state: "queued",
          message,
        },
      ],
    });
    const queue = ["before", "retained", "new"].map((id, index) => ({
      id,
      text: message.content,
      createdAt: 100 + index,
      sendRunId: `${id}-run`,
      sendState: "waiting-reconnect" as const,
    }));
    const onQueueRemove = vi.fn();
    const onQueueMove = vi.fn();
    const container = renderChatView({
      historyState,
      messages: [],
      queue,
      onQueueRemove,
      onQueueMove,
    });

    const rows = container.querySelectorAll(".chat-queue__item");
    expect([...rows].map((row) => row.getAttribute("data-chat-queue-item"))).toEqual([
      "before",
      "new",
    ]);
    const grips = [...container.querySelectorAll<HTMLButtonElement>(".chat-queue__grip")];
    expect(grips).toHaveLength(2);
    expect(grips.every((grip) => grip.disabled)).toBe(true);
    grips[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(onQueueMove).not.toHaveBeenCalled();
    rows[1]?.querySelector<HTMLButtonElement>(".chat-queue__remove")?.click();
    expect(onQueueRemove).toHaveBeenCalledWith("new");
    expect(queue).toHaveLength(3);
  });
});

describe("direct thread avatar mode", () => {
  function sessionsListWithKind(sessionKey: string, kind: "direct" | "group" | "global") {
    return {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: 200_000 },
      sessions: [{ key: sessionKey, kind, updatedAt: 1 }],
    };
  }

  const labeledHistory = [
    { role: "user", content: "hi", timestamp: 1 },
    { role: "assistant", content: "hello", timestamp: 2 },
    { role: "user", content: "me too", senderLabel: "Mario", timestamp: 3 },
  ];

  const globalHost = {
    agentsList: { defaultId: "work", mainKey: "main", scope: "global" as const },
    hello: null,
  };
  const message = [{ role: "user", content: "hi", timestamp: 1 }] satisfies Parameters<
    typeof renderChat
  >[0]["messages"];
  const avatarCase = (
    sessionKey: string,
    direct: boolean,
    overrides: Partial<Parameters<typeof renderChat>[0]> = {},
  ) => ({ props: { sessionKey, messages: message, ...overrides }, direct });

  it.each([
    [
      "keeps avatars in direct sessions when the gateway attributes identities",
      [
        avatarCase("kind-direct", false, {
          sessions: sessionsListWithKind("kind-direct", "direct"),
          messages: labeledHistory,
          userId: "profile-1",
        }),
      ],
    ],
    [
      "classifies global-scope main aliases without a listed global row",
      [avatarCase("agent:work:main", false, { sessionHost: globalHost })],
    ],
    [
      "keeps avatars when a forwarded cross-session message joins a direct thread",
      [
        avatarCase("kind-direct", false, {
          sessions: sessionsListWithKind("kind-direct", "direct"),
          messages: [
            { role: "user", content: "hi", timestamp: 1 },
            {
              role: "assistant",
              content: "forwarded report",
              timestamp: 2,
              senderLabel: "Forwarded from scout",
              senderSession: { sessionKey: "agent:scout:main", agentId: "scout" },
              provenance: {
                kind: "inter_session",
                sourceSessionKey: "agent:scout:main",
                sourceTool: "sessions_send",
              },
            },
          ],
        }),
      ],
    ],
  ])("%s", (_name, cases) => {
    for (const { props, direct } of cases) {
      const container = renderChatView(props);
      expect(
        requireElement(container, ".chat-thread", "chat thread").classList.contains(
          "chat-thread--direct",
        ),
      ).toBe(direct);
    }
  });
});

describe("chat code-block copy", () => {
  it("does not decode unmarked raw data-code payloads that start with the block-art prefix", async () => {
    const payload = 'openclaw:block-art-code:"literal"';
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const container = renderChatView();
    const thread = requireElement(container, ".chat-thread", "chat thread");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-block-copy";
    button.dataset.code = payload;
    thread.appendChild(button);

    button.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(payload);
  });
});

describe("chat transcript rendering", () => {
  it("refreshes cached inline reply handlers when the callback identity changes", () => {
    // Freeze the separate minute-based timestamp dependency while checking callback rebinding.
    vi.spyOn(Date, "now").mockReturnValue(60_000);
    const transcript = createTestTranscript();
    const firstReply = vi.fn();
    const currentReply = vi.fn();
    const message = { role: "assistant", content: "Reply target", timestamp: 1 };
    const messages = [message];
    const stableChatItems = [
      {
        kind: "group",
        key: "group:assistant:reply-callback-cache",
        role: "assistant",
        visibleContent: "text",
        messages: [createMessageEntry("message:reply-callback-cache", message)],
        timestamp: 1,
        isStreaming: false,
      },
    ] as ReturnType<typeof chatThread.buildCachedChatItems>;
    buildChatItemsMock.mockReturnValue(stableChatItems);
    renderMessageGroupMock.mockImplementation(
      (
        ...[_group, opts]: Parameters<typeof chatMessage.renderMessageGroup>
      ): ReturnType<typeof chatMessage.renderMessageGroup> => html`
        <button
          aria-label="Reply to message"
          @click=${() =>
            opts.onReply?.({
              messageId: "assistant-message",
              senderLabel: "Val",
              text: "Reply target",
            })}
        >
          Reply
        </button>
      `,
    );
    const container = document.createElement("div");
    const renderWithReply = (onSetReply: typeof firstReply) => {
      render(
        renderChat(
          createChatProps({
            paneId: "reply-callback-cache",
            transcript,
            messages,
            onSetReply,
          }),
        ),
        container,
      );
    };

    renderWithReply(firstReply);
    renderWithReply(currentReply);
    expect(renderMessageGroupMock).toHaveBeenCalledOnce();
    requireElement(
      container,
      '[aria-label="Reply to message"]',
      "inline reply button",
    ).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(firstReply).not.toHaveBeenCalled();
    expect(currentReply).toHaveBeenCalledOnce();
  });

  it("does not announce appended assistant rows in an inactive pane", () => {
    const transcript = createTestTranscript();
    const container = document.createElement("div");
    const message = (key: string, role: "user" | "assistant", content: string) => ({
      testVirtualRow: true,
      testVirtualKey: key,
      testVirtualRole: role,
      content,
    });
    const renderMessages = (messages: unknown[]) =>
      renderChatInto(container, { announceTranscript: false, transcript, messages });

    const existing = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "Existing answer"),
    ];
    renderMessages(existing);
    expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe("");

    renderMessages([
      message("older-user", "user", "Older question"),
      message("older-assistant", "assistant", "Older answer"),
      ...existing,
    ]);
    expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe("");

    renderMessages([
      message("older-user", "user", "Older question"),
      message("older-assistant", "assistant", "Older answer"),
      ...existing,
      message("user-2", "user", "New question"),
      message("assistant-2", "assistant", "New answer"),
    ]);
    expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe("");
  });

  it.each(["ordinary"])(
    "announces named attachment failures within the cap in %s assistant rows",
    (flow) => {
      const transcript = createTestTranscript();
      const container = document.createElement("div");
      const existing = {
        testVirtualRow: true,
        testVirtualKey: "assistant-existing",
        testVirtualRole: "assistant",
        role: "assistant",
        content: "Existing answer",
      };
      const renderMessages = (messages: unknown[]) =>
        renderChatInto(container, { transcript, messages });

      renderMessages([existing]);
      expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe("");
      const attachmentOnly = {
        testVirtualRow: true,
        testVirtualKey: "assistant-missing-attachment",
        testVirtualRole: "assistant",
        role: "assistant",
        content: [
          {
            type: "attachment_error",
            attachment: { code: "file-not-found", kind: "document", label: "missing.pdf" },
          },
        ],
      };
      renderMessages([existing, attachmentOnly]);
      expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
        "missing.pdf: Not sent. File not found. Check the path and try again.",
      );

      const mixed = {
        testVirtualRow: true,
        testVirtualKey: "assistant-mixed-attachments",
        testVirtualRole: "assistant",
        role: "assistant",
        content: [
          { type: "text", text: "Partial result" },
          {
            type: "attachment_error",
            attachment: {
              code: "unsupported-format",
              kind: "document",
              label: "settings.toml",
            },
          },
        ],
      };
      renderMessages([existing, attachmentOnly, mixed]);
      const mixedAnnouncement = container.querySelector(
        ".chat-transcript-announcement",
      )?.textContent;

      const runBoundary = {
        kind: "group" as const,
        key: "group:user:attachment-run",
        role: "user" as const,
        visibleContent: "text" as const,
        messages: [
          createMessageEntry("user:attachment-run", {
            role: "user",
            content: "Send the attachment",
            __openclaw: {
              id: "user:attachment-run",
              idempotencyKey: "attachment-run:user",
            },
          }),
        ],
        timestamp: 1,
        isStreaming: false,
      };
      const completedFailure = {
        kind: "group" as const,
        key: "group:assistant:attachment-run",
        role: "assistant" as const,
        visibleContent: "non-text" as const,
        messages: [
          createMessageEntry("assistant:attachment-run", {
            role: "assistant",
            content: attachmentOnly.content,
            runId: "attachment-run",
          }),
        ],
        timestamp: 2,
        isStreaming: false,
        runId: "attachment-run",
      };
      vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([
        runBoundary,
        completedFailure,
      ] as ReturnType<typeof chatThread.buildCachedChatItems>);
      renderChatInto(container, {
        transcript,
        messages: [runBoundary, completedFailure],
      });
      expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
        "missing.pdf: Not sent. File not found. Check the path and try again.",
      );

      for (const [index, prose] of [
        "Here is the requested summary. ".repeat(25),
        `${"x".repeat(430)}🦞${"y".repeat(100)}`,
      ].entries()) {
        const message = {
          role: "assistant",
          content: [{ type: "text", text: prose }, ...attachmentOnly.content],
          runId: "attachment-run",
        };
        const reply = {
          ...completedFailure,
          key: `group:assistant:long-${index}`,
          messages: [createMessageEntry(`assistant:long-${index}`, message)],
          isStreaming: flow === "active",
        };
        const items = flow === "ordinary" ? [reply] : [runBoundary, reply];
        vi.mocked(chatThread.buildCachedChatItems).mockReturnValue(items);
        renderChatInto(container, { transcript, messages: items });
        const announcement = expectDefined(
          container.querySelector(".chat-transcript-announcement")?.textContent,
          "attachment failure announcement",
        );
        expect(announcement).toContain(
          "missing.pdf: Not sent. File not found. Check the path and try again.",
        );
        expect(announcement).toContain(prose.slice(0, 30));
        expect(announcement.length).toBe(index === 0 ? 500 : 499);
        expect(announcement).not.toMatch(/[\uD800-\uDFFF]/u);

        vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([
          ...items.slice(0, -1),
          { ...reply, messages: [createMessageEntry(`assistant:long-${index}`, mixed)] },
        ]);
        renderChatInto(container, { transcript, messages: [mixed] });
        expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
          announcement,
        );
      }
      expect(mixedAnnouncement).toBe(
        "settings.toml: Not sent. Rejected by the local attachment allowlist. Send a supported file type. Partial result",
      );
    },
  );

  it("announces a run preamble and its later terminal answer separately", () => {
    const transcript = createTestTranscript();
    const container = document.createElement("div");
    const user = {
      kind: "group",
      key: "group:user:announcement",
      role: "user",
      visibleContent: "text",
      messages: [
        {
          key: "message:user:announcement",
          message: {
            role: "user",
            content: "Start",
            __openclaw: { id: "user:announcement", idempotencyKey: "run-announcement:user" },
          },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    };
    const renderItems = (items: ReturnType<typeof chatThread.buildCachedChatItems>) => {
      vi.mocked(chatThread.buildCachedChatItems).mockReturnValue(items);
      renderChatInto(container, { transcript, messages: items });
    };

    renderItems([user] as ReturnType<typeof chatThread.buildCachedChatItems>);
    const stream = {
      kind: "stream" as const,
      key: "stream:announcement",
      text: "Latest streamed narration",
      startedAt: 2,
      isStreaming: true,
      runId: "run-announcement",
      boundaryId: "send:run-announcement",
    };
    renderItems([
      user,
      stream,
      {
        kind: "reading-indicator",
        key: "reading:announcement",
        startedAt: 2,
        runId: "run-announcement",
        boundaryId: "send:run-announcement",
      },
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);

    expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
      "Latest streamed narration",
    );

    renderItems([
      user,
      {
        kind: "group",
        key: "group:assistant:persisted-announcement",
        role: "assistant",
        visibleContent: "text",
        messages: [
          {
            key: "assistant:persisted-announcement",
            message: {
              role: "assistant",
              content: "Persisted narration while the run continues",
              runId: "run-announcement",
            },
          },
        ],
        timestamp: 3,
        isStreaming: false,
        runId: "run-announcement",
      },
      {
        kind: "reading-indicator",
        key: "reading:persisted-announcement",
        startedAt: 4,
        runId: "run-announcement",
        boundaryId: "send:run-announcement",
      },
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);

    expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
      "Persisted narration while the run continues",
    );

    renderItems([
      user,
      { ...stream, isStreaming: false },
      {
        kind: "group",
        key: "group:tool:announcement",
        role: "tool",
        visibleContent: "text",
        messages: [
          {
            key: "tool:announcement",
            message: {
              role: "toolResult",
              content: "Tool output",
              runId: "run-announcement",
            },
          },
        ],
        timestamp: 3,
        isStreaming: false,
        runId: "run-announcement",
      },
      {
        kind: "group",
        key: "group:assistant:announcement",
        role: "assistant",
        visibleContent: "text",
        messages: [
          {
            key: "assistant:announcement",
            message: {
              role: "assistant",
              phase: "final_answer",
              content: "Terminal answer",
              runId: "run-announcement",
            },
          },
        ],
        timestamp: 4,
        isStreaming: false,
        runId: "run-announcement",
      },
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);

    expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
      "Terminal answer",
    );
  });
});

describe("chat composer workbench", () => {
  it("opens inline Markdown images", () => {
    const onOpenImage = vi.fn();
    const src = "data:image/png;base64,cG5n";
    const container = renderChatView({ onOpenImage });
    const trigger = document.createElement("button");
    trigger.className = "markdown-inline-image-button";
    const inlineImage = document.createElement("img");
    inlineImage.className = "markdown-inline-image";
    inlineImage.src = src;
    inlineImage.alt = "Markdown preview";
    trigger.append(inlineImage);
    container.querySelector(".chat")?.append(trigger);

    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onOpenImage).toHaveBeenCalledWith({ src, title: "Markdown preview" });

    const fallbackContainer = renderChatView();
    const fallbackTrigger = trigger.cloneNode(true) as HTMLButtonElement;
    fallbackContainer.querySelector(".chat")?.append(fallbackTrigger);
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    fallbackTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openSpy).toHaveBeenCalledWith(src, "_blank", "noopener,noreferrer");
    openSpy.mockRestore();
  });
});

afterEach(() => {
  releaseChatAttachmentPayloads([...registeredAttachmentPayloads.values()]);
  registeredAttachmentPayloads.clear();
  vi.useRealTimers();
  // Restore defaults even when a case fails with an override installed.
  buildChatItemsMock.mockReset();
  renderMessageGroupMock.mockReset();
  resetChatViewState();
  replaceSlashCommands(buildFallbackSlashCommands());
  resetTranscriptTestDom();
});

describe("per-pane chat presentation state", () => {
  it.each(["MacIntel"])(
    "uses the platform search shortcut on %s without consuming text navigation",
    async (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const primary = platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true };
      const other = platform === "MacIntel" ? { ctrlKey: true } : { metaKey: true };
      const container = document.createElement("div");
      document.body.append(container);
      const onRequestUpdate = vi.fn(() => renderChatInto(container, { onRequestUpdate }));
      try {
        renderChatInto(container, { onRequestUpdate });
        const composer = getComposerTextarea(container);
        composer.focus();
        for (const key of ["f", "а"]) {
          const navigationEvent = new KeyboardEvent("keydown", {
            key,
            code: "KeyF",
            ...other,
            bubbles: true,
            cancelable: true,
          });
          composer.dispatchEvent(navigationEvent);
          expect(navigationEvent.defaultPrevented).toBe(false);
          expect(container.querySelector(".agent-chat__search-bar")).toBeNull();
          expect(document.activeElement).toBe(composer);
          onRequestUpdate.mockClear();
          const event = new KeyboardEvent("keydown", {
            key,
            code: "KeyF",
            ...primary,
            bubbles: true,
            cancelable: true,
          });

          composer.dispatchEvent(event);
          await Promise.resolve();

          expect(event.defaultPrevented).toBe(true);
          expect(onRequestUpdate).toHaveBeenCalledOnce();
          expect(document.activeElement).toBe(
            container.querySelector<HTMLInputElement>('.agent-chat__search-bar input[type="text"]'),
          );

          const closeEvent = new KeyboardEvent("keydown", {
            key,
            code: "KeyF",
            ...primary,
            bubbles: true,
            cancelable: true,
          });
          document.activeElement?.dispatchEvent(closeEvent);
          await Promise.resolve();

          expect(closeEvent.defaultPrevented).toBe(true);
          expect(onRequestUpdate).toHaveBeenCalledTimes(2);
          expect(document.activeElement).toBe(composer);
          expect(container.querySelector(".agent-chat__search-bar")).toBeNull();
        }
      } finally {
        container.remove();
      }
    },
  );

  it("returns focus to the composer when the original target disappears", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onRequestUpdate = vi.fn(() => renderChatInto(container, { onRequestUpdate }));
    try {
      renderChatInto(container, { onRequestUpdate });
      const composer = getComposerTextarea(container);
      const transientTarget = document.createElement("button");
      const chat = container.querySelector<HTMLElement>(".chat");
      if (!chat) {
        throw new Error("expected chat section");
      }
      chat.append(transientTarget);
      transientTarget.focus();

      transientTarget.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          code: "KeyF",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();

      transientTarget.remove();
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          code: "KeyF",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();

      expect(document.activeElement).toBe(composer);
    } finally {
      container.remove();
    }
  });

  it("keeps search state and resets scoped to its pane", () => {
    const paneA = document.createElement("div");
    const paneB = document.createElement("div");
    const selector = ".agent-chat__search-bar";
    const renderPane = (container: HTMLElement, paneId: string) =>
      renderChatInto(container, { paneId, draft: "", getDraft: () => "" });
    const open = (container: HTMLElement, paneId: string) => {
      toggleTranscriptSearch(paneId, vi.fn());
      renderPane(container, paneId);
    };
    renderPane(paneA, "pane-a");
    renderPane(paneB, "pane-b");
    open(paneA, "pane-a");
    expect(paneA.querySelector(selector)).not.toBeNull();
    expect(paneB.querySelector(selector)).toBeNull();
    open(paneB, "pane-b");
    resetTranscriptSession("pane-a");
    renderPane(paneA, "pane-a");
    renderPane(paneB, "pane-b");
    expect(paneA.querySelector(selector)).toBeNull();
    expect(paneB.querySelector(selector)).not.toBeNull();
  });
});

describe("chat loading skeleton", () => {
  function createPendingSend(overrides: Partial<ChatQueueItem> = {}): ChatQueueItem {
    return {
      id: "send-main",
      text: "hello",
      createdAt: 1,
      sendRunId: "run-main",
      sendState: "sending",
      sessionKey: "main",
      ...overrides,
    };
  }

  function createContextUsageSessions(): SessionsListResult {
    return {
      ts: 0,
      path: "",
      count: 1,
      defaults: {
        modelProvider: "openai",
        model: "gpt-5.5",
        contextTokens: 200_000,
      },
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          totalTokens: 46_000,
          totalTokensFresh: true,
        },
      ],
    };
  }

  it("retires only the exact saved Talk entries, retaining unsaved speech and repeated words", () => {
    const container = renderChatView({
      realtimeTalkActive: true,
      messages: [{ role: "user", content: "Repeated words", __openclaw: { id: "voice:call:1" } }],
      realtimeTalkConversation: [
        {
          id: "u1",
          role: "user",
          text: "Repeated words",
          isStreaming: false,
          transcriptId: "voice:call:1",
        },
        {
          id: "u2",
          role: "user",
          text: "Repeated words",
          isStreaming: false,
          transcriptId: "voice:call:2",
        },
        { id: "a1", role: "assistant", text: "Still speaking", isStreaming: true },
      ],
    });
    const turns = [...container.querySelectorAll(".agent-chat__voice-turn")];
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "You Repeated words",
      "Val Still speaking",
    ]);
  });

  it("releases the embedded status when later work steals ownership from an unchanged reply", () => {
    // Rows memoize on their own item identity, so an unchanged reply that
    // stops owning the status must still re-render without it.
    const replyGroup = {
      kind: "group",
      key: "group:assistant:reply",
      role: "assistant",
      visibleContent: "text",
      messages: [
        {
          key: "message:assistant:reply",
          message: { role: "assistant", content: "Interim answer", timestamp: 1 },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    };
    const readingIndicator = { kind: "reading-indicator", key: "reading:test", startedAt: 1 };
    const toolGroup = {
      kind: "group",
      key: "group:tool:later",
      role: "tool",
      visibleContent: "text",
      messages: [
        {
          key: "message:tool:later",
          message: { role: "tool", content: "Later tool result", timestamp: 2 },
        },
      ],
      timestamp: 2,
      isStreaming: false,
    };
    const props = {
      canAbort: true,
      messages: [{ role: "assistant", content: "Interim answer", timestamp: 1 }],
      stream: null,
    };
    const container = document.createElement("div");

    vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([
      replyGroup,
      readingIndicator,
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);
    renderChatInto(container, props);
    expect(renderMessageGroupMock.mock.calls.at(-1)?.[1].activeContinuation).toBeDefined();

    renderMessageGroupMock.mockClear();
    vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([
      replyGroup,
      toolGroup,
      readingIndicator,
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);
    renderChatInto(container, props);

    const replyCall = renderMessageGroupMock.mock.calls.find(
      ([group]) => group.key === replyGroup.key,
    );
    expect(replyCall).toBeDefined();
    expect(replyCall?.[1].activeContinuation).toBeUndefined();
  });

  it("shows prompt-bar progress beside context usage while the current session send is awaiting acknowledgement", () => {
    const container = renderChatView({
      sending: true,
      composerControls: html`<button class="chat-composer-model-control" type="button">
        Model
      </button>`,
      queue: [createPendingSend()],
      selectedSession: createContextUsageSessions().sessions[0],
    });

    // The composer shows no working chrome; the thread spark is the visible
    // signal and the sr-only region carries the phase announcement.
    const context = container.querySelector(".context-ring");
    const contextUsage = context?.closest(".context-usage");
    expect(container.querySelector(".agent-chat__run-status")).toBeNull();
    expect(container.querySelector(".agent-chat__run-status-announcement")?.textContent).toContain(
      "Sending message",
    );
    expect(container.querySelector(".chat-reading-indicator")).not.toBeNull();
    expect(contextUsage?.closest(".agent-chat__composer-context")).not.toBeNull();
  });

  it("keeps subscription usage and its navigation scoped to the configured base path", () => {
    const container = renderChatView({
      providerUsage: {
        basePath: "/rosita",
        modelAuthStatusResult: {
          ts: Date.now(),
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai", type: "oauth", status: "ok" }],
              usage: { providerId: "openai", windows: [{ label: "Week", usedPercent: 72 }] },
            },
          ],
        },
      },
      messages: [
        {
          role: "assistant",
          provider: "openai",
          responseModel: "gpt-5.5",
          cost: { input: 0.001, output: 0.002 },
        },
      ],
      selectedSession: createContextUsageSessions().sessions[0],
    });

    // The session provider matches a plan-usage group, so dollar estimates
    // yield to the subscription windows.
    expect(container.querySelector("[data-chat-usage-provider='true']")?.textContent).toContain(
      "OpenAI",
    );
    const limitRow = container.querySelector(".context-usage__limit");
    expect(limitRow?.textContent?.replace(/\s+/g, " ").trim()).toBe("Weekly 72%");
    const usageLink = container.querySelector<HTMLAnchorElement>(
      ".context-usage__popover [data-chat-provider-usage='true']",
    );
    expect(usageLink?.getAttribute("href")).toBe("/rosita/usage");
  });

  it.each([
    [
      "shows active model-switch progress over the previous run's terminal status",
      {
        runStatus: {
          phase: "done" as const,
          runId: "run-previous",
          sessionKey: "main",
          occurredAt: 1_000,
        },
        queue: [createPendingSend({ createdAt: 999, sendState: "waiting-model" })],
      },
      "Preparing model",
      false,
      true,
    ],
  ])("%s", (_name, props, announcement, exact, spark) => {
    const container = renderChatView(props);
    const announcementElement = container.querySelector(".agent-chat__run-status-announcement");
    expect(announcementElement).not.toBeNull();
    const actual = announcementElement?.textContent?.trim() ?? "";
    if (exact) {
      expect(actual).toBe(announcement);
    } else {
      expect(actual).toContain(announcement);
    }
    expect(container.querySelector(".chat-reading-indicator") !== null).toBe(spark);
  });

  it("lets terminal run status win over stale abortable session UI", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const container = renderChatView({
        canAbort: true,
        runStatus: {
          phase: "done",
          runId: "run-1",
          sessionKey: "main",
          occurredAt: 1_000,
        },
        sessions: {
          ts: 0,
          path: "",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: 200_000 },
          sessions: [
            {
              key: "main",
              kind: "direct",
              updatedAt: null,
              hasActiveRun: true,
              status: "done",
              totalTokens: 190_000,
              contextTokens: 200_000,
            },
          ],
        },
      });

      expect(
        container.querySelector(".agent-chat__run-status-announcement")?.textContent?.trim(),
      ).toBe("Done");
      expect(container.querySelector(".agent-chat__run-status")).toBeNull();
      expect(container.querySelector(".chat-reading-indicator")).toBeNull();
      expect(container.querySelector(".chat-send-btn--stop")).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("announces interruptions without a composer badge", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const container = renderChatView({
        messages: [{ role: "assistant", content: "Partial response" }],
        composerControls: html`<button class="chat-composer-model-control" type="button">
          Model
        </button>`,
        runStatus: {
          phase: "interrupted",
          runId: "run-1",
          sessionKey: "main",
          occurredAt: 1_000,
        },
      });

      expect(container.querySelector(".agent-chat__composer-run-status")).toBeNull();
      expect(container.querySelector(".agent-chat__run-status")).toBeNull();
      expect(
        container.querySelector(".agent-chat__run-status-announcement")?.textContent?.trim(),
      ).toBe("Interrupted");
      expect(container.querySelector(".chat-reading-indicator")).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps a completed recap after later tool content", () => {
    vi.mocked(chatThread.buildCachedChatItems).mockReturnValueOnce([
      {
        kind: "group",
        key: "group:assistant:test",
        role: "assistant",
        visibleContent: "text",
        messages: [
          createMessageEntry("message:assistant:test", {
            role: "assistant",
            content: "Interim answer",
            timestamp: 1,
          }),
        ],
        timestamp: 1,
        isStreaming: false,
      },
      {
        kind: "group",
        key: "group:tool:test",
        role: "tool",
        visibleContent: "text",
        messages: [
          createMessageEntry("message:tool:test", {
            role: "tool",
            content: "Later tool result",
            timestamp: 2,
          }),
        ],
        timestamp: 2,
        isStreaming: false,
      },
    ]);
    vi.spyOn(chatProgress, "resolveTurnRecap").mockReturnValue({
      runId: "run-composed",
      runtimeMs: 5_000,
      outputTokens: 42,
    });

    const container = renderChatView({
      messages: [{ role: "assistant", content: "Interim answer", timestamp: 1 }],
    });

    expect(renderMessageGroupMock.mock.calls[0]?.[1].turnRecap).toBeUndefined();
    expect(container.querySelector(".chat-turn-recap")?.textContent).toContain("Done in");
  });
});

describe("chat voice controls", () => {
  it("toggles camera inside a video-capable voice session and renders the preview", () => {
    const onToggleRealtimeCamera = vi.fn();
    const stream = {} as MediaStream;
    let container = renderChatView({
      realtimeTalkActive: true,
      realtimeTalkStatus: "listening",
      realtimeTalkVideoCapable: true,
      onToggleRealtimeCamera,
    });

    requireElement(container, '[aria-label="Turn camera on"]', "camera on button").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(onToggleRealtimeCamera).toHaveBeenCalledOnce();

    container = renderChatView({
      realtimeTalkActive: true,
      realtimeTalkStatus: "listening",
      realtimeTalkVideoCapable: true,
      realtimeTalkVideoStream: stream,
      onToggleRealtimeCamera,
    });
    requireElement(container, '[aria-label="Turn camera off"]', "camera off button").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    const preview = requireElement(
      container,
      'video[aria-label="Camera preview"]',
      "camera preview",
    ) as HTMLVideoElement;
    expect(onToggleRealtimeCamera).toHaveBeenCalledTimes(2);
    expect(preview.srcObject).toBe(stream);
    expect(preview.autoplay).toBe(true);
    expect(preview.muted).toBe(true);
  });

  it("stops active voice input without sending a composed draft", () => {
    const onSend = vi.fn();
    const onToggleRealtimeTalk = vi.fn();
    const container = renderChatView({
      draft: "Keep this draft",
      realtimeTalkActive: true,
      onSend,
      onToggleRealtimeTalk,
    });

    const stop = requireElement(
      container,
      '[aria-label="Stop voice input"]',
      "stop voice input button",
    );
    stop.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onToggleRealtimeTalk).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([
    ["connecting", "Connecting voice input..."],
    ["thinking", "Asking OpenClaw..."],
  ] as const)("renders %s voice activity with the appropriate status region", (status, label) => {
    const inputLevel = new RealtimeTalkLevelSignal();
    inputLevel.set(0.64);
    const container = renderChatView({
      realtimeTalkActive: true,
      realtimeTalkStatus: status,
      realtimeTalkInputLevel: inputLevel,
    });

    const stopVoiceButton = container.querySelector('button[aria-label="Stop voice input"]');
    const visualizer = stopVoiceButton?.querySelector<HTMLElement>(
      `.agent-chat__voice-activity[data-status="${status}"]`,
    );
    expect(visualizer?.getAttribute("data-level")).toBe("0.64");
    expect(visualizer?.getAttribute("data-source")).toBe("microphone");
    expect(visualizer?.getAttribute("aria-hidden")).toBe("true");
    expect(visualizer?.querySelectorAll(".agent-chat__voice-activity-bar")).toHaveLength(7);
    const statusRegion = container.querySelector(
      status === "connecting"
        ? '[role="status"].agent-chat__talk-status'
        : '[role="status"].agent-chat__voice-status',
    );
    expect(statusRegion?.getAttribute("aria-live")).toBe("polite");
    expect(statusRegion?.getAttribute("aria-atomic")).toBe("true");
    expect(statusRegion?.textContent?.trim()).toBe(label);
    if (status !== "connecting") {
      expect(container.querySelector(".agent-chat__talk-status")).toBeNull();
    }
  });

  it("renders voice errors with the active-session controls", () => {
    const detail = "Microphone unavailable";
    const onDismissRealtimeTalkError = vi.fn();
    const container = renderChatView({
      realtimeTalkActive: true,
      realtimeTalkStatus: "error",
      realtimeTalkDetail: detail,
      onDismissRealtimeTalkError,
    });
    expect(
      container
        .querySelector('[role="alert"].agent-chat__talk-status .agent-chat__talk-status-text')
        ?.textContent?.trim(),
    ).toBe(detail);
    const stop = requireElement(
      container,
      '[aria-label="Stop voice input"]',
      "stop voice input button",
    );
    expect(stop.classList.contains("chat-send-btn--voice-error")).toBe(true);
    expect(stop.querySelector(".agent-chat__voice-activity")).toBeNull();
    expect(container.querySelector(".agent-chat__voice-status")).toBeNull();
  });

  it("updates microphone bars without rerendering the chat", () => {
    const inputLevel = new RealtimeTalkLevelSignal();
    inputLevel.set(0.2);
    const container = renderChatView({
      realtimeTalkActive: true,
      realtimeTalkStatus: "listening",
      realtimeTalkInputLevel: inputLevel,
    });
    document.body.append(container);
    try {
      const visualizer = container.querySelector<HTMLElement>(".agent-chat__voice-activity");
      const centerBar = visualizer?.querySelector<HTMLElement>(
        ".agent-chat__voice-activity-bar:nth-child(4)",
      );
      const initialScale = centerBar?.style.getPropertyValue("--talk-bar-scale");

      inputLevel.set(0.8);

      expect(visualizer?.getAttribute("data-level")).toBe("0.8");
      expect(centerBar?.style.getPropertyValue("--talk-bar-scale")).not.toBe(initialScale);
    } finally {
      container.remove();
    }
  });

  it("focuses the composer from non-control input chrome", () => {
    const container = renderChatView();
    const composerFooter = requireElement(
      container,
      ".agent-chat__composer-footer",
      "composer footer",
    );
    const textarea = getComposerTextarea(container);
    const focusSpy = vi.spyOn(textarea, "focus");

    composerFooter.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
  });
});

describe("chat composer render invalidation", () => {
  it("keeps steady ordinary edits and direction changes local", () => {
    const container = document.createElement("div");
    let draft = "a";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    let props = createChatProps({
      draft,
      getDraft: () => draft,
      onDraftChange,
    });
    const onRequestUpdate = vi.fn(() => {
      props = { ...props, draft, getDraft: () => draft };
      render(renderChat(props), container);
    });
    props = { ...props, onRequestUpdate };
    render(renderChat(props), container);

    const textarea = getComposerTextarea(container);
    onRequestUpdate.mockClear();
    vi.mocked(chatThread.buildCachedChatItems).mockClear();

    textarea.value = "ab";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    textarea.value = "abc";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    expect(draft).toBe("abc");
    expect(onRequestUpdate).not.toHaveBeenCalled();
    expect(chatThread.buildCachedChatItems).not.toHaveBeenCalled();

    textarea.value = "مرحبا";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    expect(onRequestUpdate).not.toHaveBeenCalled();
    expect(chatThread.buildCachedChatItems).not.toHaveBeenCalled();
    expect(textarea.dir).toBe("rtl");

    render(renderChat(props), container);
    expect(getComposerTextarea(container).dir).toBe("rtl");
  });
});

describe("chat slash menu accessibility", () => {
  function replayInput(textarea: HTMLTextAreaElement, value: string, type = "input") {
    if (type === "input") {
      textarea.value = value;
    }
    textarea.dispatchEvent(
      new InputEvent(type, { bubbles: true, data: value, inputType: "insertText" }),
    );
  }

  function createSessionDraftHarness(prefix: string) {
    const drafts: Record<string, string> = { [`${prefix}-a`]: "", [`${prefix}-b`]: "" };
    const onDraftChange = vi.fn((sessionKey: string, next: string) => {
      drafts[sessionKey] = next;
    });
    const container = document.createElement("div");
    const renderSession = (sessionKey: string) => {
      renderChatInto(container, {
        currentAgentId: `${prefix}-agent`,
        draft: expectDefined(drafts[sessionKey], "session draft"),
        getDraft: () => expectDefined(drafts[sessionKey], "session draft"),
        onDraftChange: (next) => onDraftChange(sessionKey, next),
        onSend: () => {
          drafts[sessionKey] = "";
        },
        sessionKey,
      });
    };
    return { container, drafts, onDraftChange, renderSession };
  }

  it.each(["keyboard", "argument-keyboard", "start", "send"])(
    "collects a literal Goal objective after %s entry and retains a rejected draft",
    async (selection) => {
      const onGoalSubmit = vi.fn(async () => false);
      const onSend = vi.fn();
      const { container } = createReactiveDraftHarness({
        onGoalSubmit,
        onSend,
        onSlashCommand: vi.fn(),
      });
      inputDraftAtEnd(container, "/goal");
      if (selection === "keyboard") {
        keydownComposer(container, "Enter");
      } else if (selection === "argument-keyboard") {
        inputDraftAtEnd(container, "/goal st");
        keydownComposer(container, "ArrowDown");
        keydownComposer(container, "Enter");
      } else if (selection === "send") {
        keydownComposer(container, "Escape");
        container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.click();
      } else {
        inputDraftAtEnd(container, `/goal ${selection} `);
      }
      expect(container.querySelector(".agent-chat__goal-mode")).not.toBeNull();
      expect(container.querySelector(".slash-menu")).toBeNull();
      expect(onGoalSubmit).not.toHaveBeenCalled();
      expect(onSend).not.toHaveBeenCalled();
      expect(getComposerTextarea(container).value).toBe("");
      keydownComposer(container, "Enter");
      expect(onGoalSubmit).not.toHaveBeenCalled();
      expect(onSend).not.toHaveBeenCalled();
      const objective = "  /stop the flaky tests\nthen preserve   every space  ";
      inputDraftAtEnd(container, objective);
      expect(container.querySelector(".slash-menu")).toBeNull();
      keydownComposer(container, "Enter");
      await vi.waitFor(() =>
        expect(onGoalSubmit).toHaveBeenCalledExactlyOnceWith(
          { action: "start", objective },
          expect.any(KeyboardEvent),
        ),
      );
      expect(getComposerTextarea(container).value).toBe(objective);
      expect(container.querySelector(".agent-chat__goal-mode")).not.toBeNull();
      expect(onSend).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(getComposerTextarea(container).readOnly).toBe(false));
      keydownComposer(container, "Escape");
      expect(container.querySelector(".agent-chat__goal-mode")).toBeNull();
      expect(getComposerTextarea(container).value).toBe(objective);
    },
  );

  it("keeps a new session draft intact when an earlier Goal edit finishes", async () => {
    const pending = createDeferred<boolean>();
    const onModeChange = vi.fn();
    const { container, renderCurrent } = createReactiveDraftHarness({
      sessionKey: "session-a",
      goalDraftMode: {
        action: "edit",
        sessionId: "id-a",
        goalId: "goal-a",
        previousDraft: "Previous session draft",
      },
      onGoalDraftModeChange: onModeChange,
      onGoalSubmit: () => pending.promise,
    });
    inputDraftAtEnd(container, "Updated objective");
    keydownComposer(container, "Enter");
    renderCurrent({ sessionKey: "session-b", goalDraftMode: null });
    inputDraftAtEnd(container, "New session draft");
    pending.resolve(true);
    await pending.promise;
    await vi.waitFor(() => expect(getComposerTextarea(container).readOnly).toBe(false));
    expect(getComposerTextarea(container).value).toBe("New session draft");
    expect(container.querySelector(".agent-chat__goal-mode")).toBeNull();
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("executes an inline command separately and removes only its token from the draft", () => {
    let draft = "";
    const onTypingChange = vi.fn();
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const onSlashCommand = vi.fn(() => {
      expect(onTypingChange).toHaveBeenLastCalledWith(true, "hello ");
    });
    const { container } = createReactiveDraftHarness({
      onDraftChange,
      onSend,
      onSlashCommand,
      onTypingChange,
    });

    inputDraftAtEnd(container, "hello /statu");

    expect(container.querySelector(".slash-menu")).not.toBeNull();
    expect(container.querySelector(".slash-menu-name")?.textContent?.trim()).toBe("/status");
    keydownComposer(container, "Enter");

    expect(onSlashCommand).toHaveBeenCalledExactlyOnceWith("/status");
    expect(draft).toBe("hello ");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(draft);
    expect(onTypingChange).toHaveBeenLastCalledWith(true, "hello ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([{ args: "example/model explain this", allowed: false }])(
    "checks the complete inline model command before sending $args",
    ({ args, allowed }) => {
      let draft = "";
      const onDraftChange = vi.fn((next: string) => {
        draft = next;
      });
      const onSend = vi.fn();
      const onSlashCommand = vi.fn();
      const { container } = createReactiveDraftHarness({
        onDraftChange,
        onSend,
        onSlashCommand,
        modelRequiredReason: "Connect a provider to send messages.",
      });
      inputDraftAtEnd(container, "retained draft /model");
      keydownComposer(container, "Enter");
      inputDraftAtEnd(container, `retained draft /model ${args}`);
      keydownComposer(container, "Enter");
      if (allowed) {
        expect(onSlashCommand).toHaveBeenCalledExactlyOnceWith(`/model ${args}`);
        expect(draft).toBe("retained draft ");
      } else {
        expect(onSlashCommand).not.toHaveBeenCalled();
        expect(draft).toBe(`retained draft /model ${args}`);
      }
      expect(onSend).not.toHaveBeenCalled();
    },
  );

  it("keeps a typed inline argument on plain Enter in modifier-enter mode", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({
      onDraftChange,
      onSend,
      onSlashCommand,
      sendShortcut: "modifier-enter",
    });

    inputDraftAtEnd(container, "hello /think high");
    const plainEnter = keydownComposer(container, "Enter");

    expect(plainEnter.defaultPrevented).toBe(false);
    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(draft).toBe("hello /think high");

    const modifierEnter = keydownComposer(container, "Enter", { ctrlKey: true });

    expect(modifierEnter.defaultPrevented).toBe(true);
    expect(onSlashCommand).toHaveBeenCalledExactlyOnceWith("/think high");
    expect(onSend).not.toHaveBeenCalled();
    expect(draft).toBe("hello ");
  });

  it("preserves typed inline argument mode across command hydration", async () => {
    let draft = "";
    let resolveRefresh: (() => void) | undefined;
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    const onSlashIntent = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const { container } = createReactiveDraftHarness({
      onDraftChange,
      onSend,
      onSlashCommand,
      onSlashIntent,
    });

    inputDraftAtEnd(container, "hello /thin");
    keydownComposer(container, "Enter");
    expect(draft).toBe("hello /think ");

    resolveRefresh?.();
    await Promise.resolve();
    await Promise.resolve();
    inputDraftAtEnd(container, "hello /think high");
    keydownComposer(container, "Enter");

    expect(onSlashCommand).toHaveBeenCalledExactlyOnceWith("/think high");
    expect(draft).toBe("hello ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("removes a typed inline command argument without consuming trailing prose", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({ onDraftChange, onSlashCommand });
    const textarea = getComposerTextarea(container);
    const initial = "before /thin after";
    const commandEnd = initial.indexOf("/thin") + "/thin".length;
    textarea.value = initial;
    textarea.setSelectionRange(commandEnd, commandEnd);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    keydownComposer(container, "Enter");
    expect(draft).toBe("before /think  after");

    const withArgument = "before /think high after";
    const argumentEnd = withArgument.indexOf("high") + "high".length;
    textarea.value = withArgument;
    textarea.setSelectionRange(argumentEnd, argumentEnd);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    keydownComposer(container, "Enter");

    expect(onSlashCommand).toHaveBeenCalledExactlyOnceWith("/think high");
    expect(draft).toBe("before after");
    expect(textarea.value).toBe(draft);
  });

  it("does not consume trailing prose as a directly typed inline argument", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({ onDraftChange, onSend, onSlashCommand });

    inputDraftAtEnd(container, "before /think high then answer concisely");
    keydownComposer(container, "Enter");

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledOnce();
    expect(draft).toBe("before /think high then answer concisely");
  });

  it("tab-completes an inline command argument without replacing surrounding prose", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({ onDraftChange, onSlashCommand });

    inputDraftAtEnd(container, "hello /verb");
    keydownComposer(container, "Tab");
    keydownComposer(container, "Tab");

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(draft).toBe("hello /verbose on ");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(draft);
  });

  it("uses a trailing colon to select only an inline skill reference", () => {
    replaceSkillCommands({ key: "weather", description: "Check the weather." });
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({ onDraftChange, onSlashCommand });

    inputDraftAtEnd(container, "Please use /weather:");
    expect(container.querySelector(".slash-menu-name")?.textContent?.trim()).toBe("/weather");
    keydownComposer(container, "Enter");

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(draft).toBe("Please use $weather ");
  });

  it("serializes a selected inline /exec host argument canonically", () => {
    let draft = "";
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    const { container } = createReactiveDraftHarness({ onDraftChange, onSend, onSlashCommand });

    inputDraftAtEnd(container, "Please /exec");
    keydownComposer(container, "Tab");
    keydownComposer(container, "Enter");

    expect(onSlashCommand).toHaveBeenCalledExactlyOnceWith("/exec host=auto");
    expect(draft).toBe("Please ");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(draft);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("uses the grouped slash menu order for keyboard selection", () => {
    replaceSlashCommands([
      {
        key: "status-report",
        name: "status-report",
        description: "Prepare a status report.",
        source: "skill",
        skillModelVisible: true,
      },
      {
        key: "status-check",
        name: "status-check",
        description: "Check current status.",
        source: "plugin",
      },
    ]);
    const harness = createSlashRerenderHarness();
    let container = harness.inputAndRender(harness.container, "/status");

    const optionNames = () =>
      Array.from(container.querySelectorAll<HTMLElement>(".slash-menu [role='option']")).map(
        (option) => option.querySelector(".slash-menu-name")?.textContent?.trim(),
      );
    expect(optionNames()).toEqual(["/status-check", "/status-report"]);

    keydownComposer(container, "Enter");
    container = harness.renderCurrent();
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("/status-check ");
  });

  it("dismisses invocation sheets on an outside pointer press", () => {
    const { container } = createReactiveDraftHarness();
    document.body.append(container);
    inputDraftAtEnd(container, "/sta");
    expect(container.querySelector(".slash-menu")).not.toBeNull();

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(container.querySelector(".slash-menu")).toBeNull();
    container.remove();
  });

  it.each([
    {
      key: "prose_writer",
      skillDisplayName: "Prose Writer",
      description: "Draft polished prose.",
      draft: "Polish this with $pro:",
      expected: "Polish this with $prose_writer:",
    },
    {
      key: "release_notes",
      description: "Draft release notes.",
      draft: "Use $release-",
      expected: "Use $release_notes ",
    },
  ])("completes $draft without submitting the surrounding prompt", async (sample) => {
    replaceSkillCommands(sample);
    let draft = "";
    const onSend = vi.fn();
    const { container } = createReactiveDraftHarness({
      onDraftChange: (next) => {
        draft = next;
      },
      onSend,
    });
    inputDraftAtEnd(container, sample.draft);
    keydownComposer(container, "Enter");
    expect(draft).toBe(sample.expected);
    expect(onSend).not.toHaveBeenCalled();
    expect(container.querySelector(".skill-menu")).toBeNull();
    await Promise.resolve();
    expect(getComposerTextarea(container).selectionStart).toBe(sample.expected.length);
  });

  it("does not submit an incomplete skill reference while the catalog is loading", () => {
    replaceSlashCommands(buildFallbackSlashCommands());
    const refresh = createDeferred();
    let draft = "";
    const onSend = vi.fn();
    const { container } = createReactiveDraftHarness({
      onDraftChange: (next) => {
        draft = next;
      },
      onSend,
      onSlashIntent: () => refresh.promise,
    });
    inputDraftAtEnd(container, "Use $pro");
    expect(container.querySelector(".skill-menu")?.textContent).toContain("Loading skills");
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
    expect(send?.disabled).toBe(true);

    keydownComposer(container, "Enter");
    send?.click();

    expect(onSend).not.toHaveBeenCalled();
    expect(draft).toBe("Use $pro");
  });

  it("scrolls the keyboard-active skill inside the nested menu viewport", () => {
    replaceSkillCommands(
      ...Array.from({ length: 8 }, (_, index) => ({
        key: `skill_${index + 1}`,
        description: `Skill ${index + 1}.`,
      })),
    );
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const height = 28;
      let top = 0;
      if (this.classList.contains("slash-menu-item")) {
        const scrollRegion = this.closest<HTMLElement>(".slash-menu__scroll");
        const options = Array.from(
          scrollRegion?.querySelectorAll<HTMLElement>(".slash-menu-item") ?? [],
        );
        top = options.indexOf(this) * height - (scrollRegion?.scrollTop ?? 0);
      }
      const bottom = this.classList.contains("slash-menu__scroll") ? height * 2 : top + height;
      return {
        bottom,
        height: bottom - top,
        left: 0,
        right: 240,
        top,
        width: 240,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    });
    const { container } = createReactiveDraftHarness();
    document.body.append(container);
    inputDraftAtEnd(container, "Use $");
    animationFrames.length = 0;

    for (let index = 0; index < 4; index += 1) {
      keydownComposer(container, "ArrowDown");
    }
    animationFrames.at(-1)?.(0);

    const scrollRegion = container.querySelector<HTMLElement>(".skill-menu .slash-menu__scroll");
    const outerMenu = container.querySelector<HTMLElement>(".skill-menu");
    const activeOption = container.querySelector<HTMLElement>(".slash-menu-item--active");
    const viewportBounds = scrollRegion?.getBoundingClientRect();
    const optionBounds = activeOption?.getBoundingClientRect();
    expect(scrollRegion?.scrollTop).toBeGreaterThan(0);
    expect(outerMenu?.scrollTop).toBe(0);
    expect(optionBounds?.top).toBeGreaterThanOrEqual(viewportBounds?.top ?? 0);
    expect(optionBounds?.bottom).toBeLessThanOrEqual(viewportBounds?.bottom ?? 0);
    container.remove();
  });

  it.each(["skill", "slash"] as const)(
    "does not reopen a stale %s picker after hydration",
    async (kind) => {
      if (kind === "skill") {
        replaceSkillCommands({ key: "prose", description: "Prose skill." });
      }
      const refresh = createDeferred();
      const { container } = createReactiveDraftHarness({ onSlashIntent: () => refresh.promise });
      const selector = kind === "skill" ? ".skill-menu" : ".slash-menu";
      inputDraftAtEnd(container, kind === "skill" ? "$pro" : "/");
      expect(container.querySelector(selector)).not.toBeNull();
      if (kind === "skill") {
        expect(container.querySelector(selector)?.textContent).toContain("Loading skills");
        expect(container.querySelectorAll(".skill-menu [role='option']")).toHaveLength(0);
        keydownComposer(container, "Escape");
      } else {
        inputDraft(container, "plain first message");
      }
      expect(container.querySelector(selector)).toBeNull();
      refresh.resolve();
      await refresh.promise;
      await Promise.resolve();
      expect(container.querySelector(selector)).toBeNull();
    },
  );

  it("closes a stale skill picker when the caret leaves its token", () => {
    replaceSkillCommands({ key: "prose", description: "Prose skill." });
    const { container } = createReactiveDraftHarness();
    let textarea = getComposerTextarea(container);
    textarea.value = "Use $pro then continue";
    textarea.setSelectionRange("Use $pro".length, "Use $pro".length);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(container.querySelector(".skill-menu")).not.toBeNull();

    textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));

    expect(container.querySelector(".skill-menu")).toBeNull();
  });

  it("matches backend escape parity and absorbs rejected skill refreshes", async () => {
    replaceSkillCommands({ key: "prose", description: "Prose skill." });
    const { container } = createReactiveDraftHarness({
      onSlashIntent: async () => {
        throw new Error("catalog unavailable");
      },
    });
    inputDraftAtEnd(container, String.raw`Use \\$pro`);
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector(".skill-menu")).not.toBeNull();
  });

  it.each([
    { commandDraft: "hello /statu", optionName: "/status", argument: false },
    { commandDraft: "/verb", optionName: "full", argument: true },
  ])(
    "does not dispatch stale $commandDraft selections after disconnect",
    ({ commandDraft, optionName, argument }) => {
      let draft = "";
      const onDraftChange = vi.fn((next: string) => {
        draft = next;
      });
      const onSend = vi.fn();
      const onSlashCommand = vi.fn();
      const { container, renderCurrent } = createReactiveDraftHarness({
        onDraftChange,
        onSend,
        onSlashCommand,
      });
      inputDraftAtEnd(container, commandDraft);
      if (argument) {
        keydownComposer(container, "Enter");
      }
      const option = Array.from(container.querySelectorAll<HTMLElement>(".slash-menu-item")).find(
        (item) => item.querySelector(".slash-menu-name")?.textContent?.trim() === optionName,
      );
      expect(option).toBeInstanceOf(HTMLElement);
      const draftBeforeDisconnect = draft;
      if (!argument) {
        expect(draft).toBe("hello /statu");
      }
      renderCurrent({ connected: false });
      option?.click();
      expect(onSlashCommand).not.toHaveBeenCalled();
      expect(onSend).not.toHaveBeenCalled();
      expect(draft).toBe(draftBeforeDisconnect);
    },
  );

  it("rejects submitted draft replay after switching sessions and entering a new draft", () => {
    const nextDraft = "new draft";
    const { container, drafts, onDraftChange, renderSession } = createSessionDraftHarness("replay");
    renderSession("replay-a");
    inputDraft(container, "submitted message");
    container.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();
    expect(getComposerTextarea(container).value).toBe("");
    const sessionKey = "replay-b";
    renderSession(sessionKey);
    const textarea = getComposerTextarea(container);
    expect(textarea.value).toBe("");
    replayInput(textarea, nextDraft, "beforeinput");
    replayInput(textarea, nextDraft);
    expect(textarea.value).toBe(nextDraft);
    replayInput(textarea, "submitted message");
    expect(textarea.value).toBe(nextDraft);
    expect(drafts[sessionKey]).toBe(nextDraft);
    expect(onDraftChange).toHaveBeenCalledTimes(2);
  });

  it("requires Ctrl or Meta to send in modifier mode", () => {
    const onDraftChange = vi.fn();
    const onSend = vi.fn();
    const container = renderChatView({
      onDraftChange,
      onSend,
      sendShortcut: "modifier-enter",
    });

    inputDraft(container, "compose across lines");
    const plainEnter = keydownComposer(container, "Enter");
    const shiftedEnter = keydownComposer(container, "Enter", { ctrlKey: true, shiftKey: true });

    expect(plainEnter.defaultPrevented).toBe(false);
    expect(shiftedEnter.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();

    keydownComposer(container, "Enter", { ctrlKey: true });
    container
      .querySelector("textarea")
      ?.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
    inputDraft(container, "compose across lines");
    keydownComposer(container, "Enter", { metaKey: true });

    expect(onDraftChange).toHaveBeenCalledWith("compose across lines", undefined);
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(container.querySelector("textarea")?.getAttribute("aria-keyshortcuts")).toBe(
      "Control+Enter Meta+Enter",
    );
  });
});

describe("chat attachment picker", () => {
  it("keeps the file drop overlay stable across nested drag targets", () => {
    const container = renderChatView();
    const chat = requireElement(container, "section.chat", "chat drop target");

    chat.dispatchEvent(createDragEvent("dragenter"));
    chat.dispatchEvent(createDragEvent("dragenter"));
    chat.dispatchEvent(createDragEvent("dragleave"));
    expect(chat.hasAttribute("data-attachment-drop-active")).toBe(true);

    chat.dispatchEvent(createDragEvent("dragleave"));
    expect(chat.hasAttribute("data-attachment-drop-active")).toBe(false);

    chat.dispatchEvent(createDragEvent("dragenter", ["application/x-openclaw-session"]));
    expect(chat.hasAttribute("data-attachment-drop-active")).toBe(false);
  });

  it("cancels non-file drops outside the composer textarea but keeps them native inside it", () => {
    const container = renderChatView();
    const chat = requireElement(container, "section.chat", "chat drop target");
    const textarea = getComposerTextarea(container);

    const outsideDrop = createDragEvent("drop", ["text/uri-list"]);
    chat.dispatchEvent(outsideDrop);
    expect(outsideDrop.defaultPrevented).toBe(true);

    const textareaDrop = createDragEvent("drop", ["text/uri-list"]);
    textarea.dispatchEvent(textareaDrop);
    expect(textareaDrop.defaultPrevented).toBe(false);

    const range = document.createElement("input");
    range.type = "range";
    chat.append(range);
    const rangeDrop = createDragEvent("drop", ["text/uri-list"]);
    range.dispatchEvent(rangeDrop);
    expect(rangeDrop.defaultPrevented).toBe(true);
  });

  it("registers a large paste before an immediate send", () => {
    let attachments: ChatAttachment[] = [];
    const onSend = vi.fn(() => {
      expect(attachments).toHaveLength(1);
    });
    const container = renderChatView({
      attachments,
      getAttachments: () => attachments,
      onAttachmentsChange: (next) => {
        attachments = next;
      },
      onSend,
    });
    const textarea = getComposerTextarea(container);
    const pastedText = `large paste ${"x".repeat(1100)}`;
    textarea.dispatchEvent(createPasteEvent(pastedText));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onSend).toHaveBeenCalledOnce();
  });

  it("preserves a large paste when a dropped file finishes later", async () => {
    const readers: FileReader[] = [];
    const readAsDataUrl = vi
      .spyOn(FileReader.prototype, "readAsDataURL")
      .mockImplementation(function (this: FileReader) {
        readers.push(this);
      });
    let attachments: ChatAttachment[] = [];
    const onAttachmentsChange = vi.fn((next: ChatAttachment[]) => {
      attachments = next;
    });
    const container = renderAttachmentHarness(() => attachments, onAttachmentsChange);
    const textarea = getComposerTextarea(container);
    const chat = requireElement(container, "section.chat", "chat drop target");
    const pastedText = `large paste ${"x".repeat(1100)}`;
    const droppedFile = new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" });
    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { files: [droppedFile], types: ["Files"] },
    });

    try {
      textarea.dispatchEvent(createPasteEvent(pastedText));
      chat.dispatchEvent(dropEvent);

      expect(readers).toHaveLength(1);
      expect(attachments).toHaveLength(1);
      Object.defineProperty(readers[0], "result", {
        configurable: true,
        value: `data:application/pdf;base64,${btoa("%PDF-1.4\n")}`,
      });
      expectDefined(readers[0], "readers[0] test invariant").dispatchEvent(
        new ProgressEvent("load"),
      );

      await waitForFast(() => expect(attachments).toHaveLength(2));
      expect(attachments.map((attachment) => attachment.fileName)).toEqual([
        expect.stringMatching(/^pasted-text-\d+\.txt$/u),
        "brief.pdf",
      ]);
    } finally {
      readAsDataUrl.mockRestore();
    }
  });

  it("keeps the default placeholder only for internally generated pasted text", () => {
    let pastedTextAttachments: ChatAttachment[] = [];
    const pasteTarget = renderChatView({
      getAttachments: () => pastedTextAttachments,
      onAttachmentsChange: (next) => {
        pastedTextAttachments = next;
      },
    });
    const textarea = getComposerTextarea(pasteTarget);
    textarea.dispatchEvent(createPasteEvent(`large paste ${"x".repeat(1100)}`));

    const namedLikePaste = registerChatAttachmentPayload({
      attachment: {
        id: "ordinary-text-file",
        fileName: "pasted-text-1.txt",
        mimeType: "text/plain",
        origin: "file",
        sizeBytes: 4,
      },
      dataUrl: `data:text/plain;base64,${btoa("file")}`,
      file: new File(["file"], "pasted-text-1.txt", { type: "text/plain" }),
    });
    const imageAttachment: ChatAttachment = {
      id: "image",
      fileName: "screen.png",
      mimeType: "image/png",
      sizeBytes: 2048,
    };

    const textOnly = renderChatView({ attachments: pastedTextAttachments });
    expect(textOnly.querySelector("textarea")?.getAttribute("placeholder")).toBe(
      t("chat.composer.placeholder", { name: "Val" }),
    );

    const ordinaryTextFile = renderChatView({ attachments: [namedLikePaste] });
    expect(ordinaryTextFile.querySelector("textarea")?.getAttribute("placeholder")).toBe(
      t("chat.composer.placeholderWithAttachments"),
    );
    expect(ordinaryTextFile.querySelector(".chat-attachment-text-action")).toBeNull();

    const withImage = renderChatView({ attachments: [imageAttachment] });
    expect(withImage.querySelector("textarea")?.getAttribute("placeholder")).toBe(
      t("chat.composer.placeholderWithAttachments"),
    );
  });

  it("renders multiple browser annotations as bounded, accessible cards", () => {
    const annotations: ChatAttachment[] = [
      {
        id: "annotation-title",
        mimeType: "image/png",
        previewUrl: "blob:annotation-title",
        browserAnnotation: {
          modelContext: "Context for the model",
          title: "Checkout page with a deliberately long title",
          displayUrl: "shop.example.test/checkout",
          markedRegionCount: 2,
          inspectedElement: true,
        },
      },
      {
        id: "annotation-url",
        mimeType: "image/png",
        previewUrl: "blob:annotation-url",
        browserAnnotation: {
          modelContext: "Second context",
          title: "",
          displayUrl: "docs.example.test/narrow-layout",
          markedRegionCount: 1,
          inspectedElement: false,
        },
      },
    ];

    const container = renderChatView({ attachments: annotations });
    const cards = container.querySelectorAll<HTMLElement>(
      ".chat-attachment-thumb--browser-annotation",
    );

    expect(cards).toHaveLength(2);
    expect(cards[0]?.dataset.attachmentId).toBe("annotation-title");
    expect(cards[0]?.getAttribute("role")).toBe("group");
    expect(cards[0]?.getAttribute("aria-label")).toBe(
      "Browser annotation: Checkout page with a deliberately long title",
    );
    expect(cards[0]?.querySelector("img")?.getAttribute("alt")).toBe("Browser annotation preview");
    expect(cards[0]?.querySelector(".chat-browser-annotation-card__identity")?.textContent).toBe(
      "Checkout page with a deliberately long title",
    );
    expect(cards[0]?.querySelector(".chat-browser-annotation-card__meta")?.textContent).toContain(
      "2 marked regions",
    );
    expect(cards[0]?.textContent).not.toContain("Element inspected");
    expect(cards[1]?.querySelector(".chat-browser-annotation-card__identity")?.textContent).toBe(
      "docs.example.test/narrow-layout",
    );
    expect(cards[1]?.textContent).toContain("1 marked region");
    expect(cards[1]?.textContent).not.toContain("Element inspected");
    expect(
      cards[0]?.querySelector(
        '[aria-label="Remove browser annotation: Checkout page with a deliberately long title"]',
      ),
    ).toBeInstanceOf(HTMLButtonElement);
    for (const card of cards) {
      expect(card.querySelector(".chat-browser-annotation-card__preview")).not.toBeNull();
      expect(card.querySelector(".chat-browser-annotation-card__body")).not.toBeNull();
    }
  });

  it.each([true, false])("routes attachment removal to its owner (annotation=%s)", (annotation) => {
    const name = annotation ? "annotation" : "ordinary";
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: `${name}-remove`,
        fileName: `${name}.png`,
        mimeType: "image/png",
        ...(annotation
          ? {
              browserAnnotation: {
                modelContext: "Context",
                title: "Account settings",
                displayUrl: "example.test/settings",
                markedRegionCount: 0,
                inspectedElement: false,
              },
            }
          : {}),
      },
      dataUrl: `data:image/png;base64,${btoa(name)}`,
      file: new File([name], `${name}.png`, { type: "image/png" }),
    });
    const onRemoveAttachment = vi.fn();
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({
      attachments: [attachment],
      onAttachmentsChange,
      onRemoveAttachment,
    });
    const label = annotation
      ? "Remove browser annotation: Account settings"
      : "Remove ordinary.png";
    requireElement(container, `[aria-label="${label}"]`, "attachment remove button").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    if (annotation) {
      expect(onRemoveAttachment).toHaveBeenCalledWith(attachment);
      expect(onAttachmentsChange).not.toHaveBeenCalled();
      expect(getChatAttachmentDataUrl(attachment)).not.toBeNull();
    } else {
      expect(onRemoveAttachment).not.toHaveBeenCalled();
      expect(onAttachmentsChange).toHaveBeenCalledWith([]);
      expect(getChatAttachmentDataUrl(attachment)).toBeNull();
    }
  });

  it("opens the scoped file input from the attachment menu", () => {
    const container = renderChatView();
    const input = requireAttachmentInput(
      container,
      ".agent-chat__file-input",
      "attachment file input",
    );
    const attachButton = getAttachmentMenuOption(container, t("chat.composer.attachFileOption"));
    const clickInput = vi.spyOn(input, "click").mockImplementation(() => undefined);

    expect(attachButton).toBeInstanceOf(HTMLElement);
    selectAttachmentMenuOption(attachButton);

    expect(clickInput).toHaveBeenCalledTimes(1);
  });

  it("opens the scoped camera dialog instead of a file picker and attaches its photo", async () => {
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({ onAttachmentsChange });
    const camera = container.querySelector("openclaw-chat-camera-capture");
    if (!camera) {
      throw new Error("Missing camera capture dialog");
    }
    const cameraButton = getAttachmentMenuOption(container, t("chat.composer.takePhoto"));
    const show = vi.spyOn(camera, "show").mockImplementation(() => undefined);
    const fileClick = vi.spyOn(HTMLInputElement.prototype, "click");
    expect(container.querySelector(".agent-chat__camera-input")).not.toBeNull();
    selectAttachmentMenuOption(cameraButton);
    expect(show).toHaveBeenCalledOnce();
    expect(fileClick).not.toHaveBeenCalled();

    const photo = new File(["photo"], "camera.jpg", { type: "image/jpeg" });
    camera.onCapture?.(photo);

    await waitForFast(() => {
      const attachments = requireFirstAttachmentsChange(onAttachmentsChange);
      expect(attachments).toHaveLength(1);
      expect(attachments[0]?.fileName).toBe("camera.jpg");
      expect(attachments[0]?.mimeType).toBe("image/jpeg");
    });
  });

  it("infers video preview glyphs from filenames when MIME is absent", async () => {
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({ onAttachmentsChange });
    const input = container.querySelector<HTMLInputElement>(".agent-chat__file-input");
    const file = new File(["video"], "clip.mp4");

    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input?.accept).toContain("video/*");
    selectFile(input!, file);

    await waitForFast(() => {
      const attachments = requireFirstAttachmentsChange(onAttachmentsChange);
      expect(attachments).toHaveLength(1);
      expect(attachments[0]?.fileName).toBe("clip.mp4");
      expect(attachments[0]?.mimeType).toBe("application/octet-stream");
      expect(attachments[0]?.sizeBytes).toBe(file.size);
    });

    const nextAttachments = requireFirstAttachmentsChange(onAttachmentsChange);
    const preview = renderChatView({ attachments: nextAttachments });
    expect(preview.querySelectorAll(".chat-attachment-thumb--file")).toHaveLength(1);
    expect(preview.querySelector(".chat-attachment-file__name")?.textContent).toBe("clip.mp4");
    expect(
      preview.querySelector(".chat-attachment-file--video .chat-attachment-file__preview svg"),
    ).not.toBeNull();
    expect(preview.querySelector(".chat-attachment-file__preview img")).toBeNull();
    expect(preview.querySelector(".chat-attachment-file__type")?.textContent).toBe("MP4");
  });
});
describe("chat welcome", () => {
  afterEach(async () => {
    await i18n.setLocale("en");
  });

  function renderWelcome(params: {
    assistantAvatar: string | null;
    assistantAvatarUrl?: string | null;
    sessions?: SessionsListResult | null;
    sessionKey?: string;
    sessionHost?: { assistantAgentId?: string | null } | null;
    onOpenSession?: (sessionKey: string) => void;
    modelSetupRequired?: boolean;
    onModelSetup?: () => void;
  }) {
    const container = document.createElement("div");
    render(
      renderWelcomeState({
        assistantName: "Val",
        onDraftChange: () => undefined,
        onSend: () => undefined,
        ...params,
      }),
      container,
    );
    return container;
  }

  it("renders configured images and emoji before the generated agent face", async () => {
    let container = renderWelcome({ assistantAvatar: "🦉", assistantAvatarUrl: null });
    const avatar = container.querySelector<HTMLElement>(".agent-chat__welcome-avatar");
    expect(avatar?.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("🦉");
    expect(avatar?.getAttribute("aria-label")).toBe("Val");

    container = renderWelcome({
      assistantAvatar: "🦉",
      assistantAvatarUrl: "blob:identity-avatar",
    });
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("blob:identity-avatar");
    image?.dispatchEvent(new Event("load"));
    const identity = container.querySelector(".identity-avatar--agent");
    expect(identity?.classList.contains("is-fallback")).toBe(false);
    image?.dispatchEvent(new Event("error"));
    expect(identity?.classList.contains("is-fallback")).toBe(true);
    expect(identity?.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("🦉");

    container = renderWelcome({ assistantAvatar: null, assistantAvatarUrl: null });
    await vi.waitFor(() =>
      expect(container.querySelector(".identity-avatar__agent-face")).not.toBeNull(),
    );
    expect(container.querySelector(".agent-chat__welcome-clawd")).toBeNull();
  });

  it("replaces sendable welcome actions with model setup", () => {
    const onModelSetup = vi.fn();
    const container = renderWelcome({
      assistantAvatar: null,
      modelSetupRequired: true,
      onModelSetup,
    });
    expect(container.textContent).toContain("No AI provider configured");
    expect(container.querySelector(".agent-chat__suggestions")).toBeNull();
    container.querySelector<HTMLButtonElement>(".agent-chat__welcome button")?.click();
    expect(onModelSetup).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "allows model-free setup commands only with write access (%s)",
    (canSend) => {
      const onModelSetup = vi.fn();
      const onSend = vi.fn();
      const container = renderChatView({
        draft: "/models",
        canSend,
        modelRequiredReason: "Connect a provider to send messages.",
        ...(canSend
          ? {
              disabledBanner: createChatModelSetupBanner(onModelSetup),
              modelSetupRequired: true,
            }
          : {}),
        onSend,
      });
      expect(getComposerTextarea(container).disabled).toBe(!canSend);
      const send = expectDefined(
        container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
        "model-free command send button",
      );
      expect(send.disabled).toBe(!canSend);
      send.click();
      expect(onSend).toHaveBeenCalledTimes(canSend ? 1 : 0);
      if (canSend) {
        expect(container.querySelector(".agent-chat__welcome--setup")).not.toBeNull();
        container.querySelector<HTMLButtonElement>(".agent-chat__disabled-banner button")?.click();
        expect(onModelSetup).toHaveBeenCalledOnce();
      }
    },
  );

  it("lists recent user chats instead of suggestions when any exist", () => {
    const opened: string[] = [];
    const container = renderWelcome({
      assistantAvatar: null,
      assistantAvatarUrl: null,
      sessionKey: "agent:main:dashboard:current",
      sessions: createSessionsResultFromRows([
        {
          key: "agent:main:dashboard:current",
          kind: "direct",
          updatedAt: 50,
          label: "Current chat",
        },
        {
          key: "agent:main:dashboard:older",
          kind: "direct",
          updatedAt: 10,
          label: "Older chat",
          pinned: true,
          pinnedAt: 5,
        },
        {
          key: "agent:main:discord:group:g-1456",
          kind: "group",
          channel: "discord",
          updatedAt: 90,
        },
        { key: "agent:main:dashboard:newer", kind: "direct", updatedAt: 40, label: "Newer chat" },
      ]),
      onOpenSession: (key) => opened.push(key),
    });

    expect(container.querySelector(".agent-chat__suggestion")).toBeNull();
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".agent-chat__recent")];
    expect(
      rows.map((row) => row.querySelector(".agent-chat__recent-name")?.textContent?.trim()),
    ).toEqual(["Newer chat", "Older chat"]);

    itemAt(rows, 0, "recent session row").click();
    expect(opened).toEqual(["agent:main:dashboard:newer"]);
  });

  it("renders welcome text from the active locale", async () => {
    await i18n.setLocale("zh-CN");
    const container = renderWelcome({ assistantAvatar: "VC", assistantAvatarUrl: null });

    expect(container.querySelector(".agent-chat__suggestion")?.textContent?.trim()).toBe(
      t("chat.welcome.suggestions.whatCanYouDo"),
    );
  });
});

describe("chat model controls", () => {
  const subscriptionProfiles = [
    { profileId: "openai:work", type: "oauth", status: "ok", email: "work@example.com" },
    { profileId: "openai:personal", type: "oauth", status: "ok", email: "peter@steipete.me" },
  ] satisfies ModelAuthStatusResult["providers"][number]["profiles"];
  const authStatus: ModelAuthStatusResult = {
    ts: 1,
    providers: [
      {
        provider: "openai-codex",
        displayName: "OpenAI",
        status: "ok",
        profiles: subscriptionProfiles,
        profileOrder: ["openai:personal", "openai:work"],
        usage: { providerId: "openai", windows: [], plan: "ChatGPT Pro" },
      },
    ],
  };

  const googleAuthProviders = [
    {
      provider: "google",
      displayName: "Google",
      status: "static",
      profiles: [{ profileId: "google:key", type: "api_key", status: "static" }],
      apiKey: { source: "env", envVar: "GEMINI_API_KEY" },
    },
    {
      provider: "google-gemini-cli",
      displayName: "Gemini CLI",
      status: "ok",
      profiles: [{ profileId: "google:oauth", type: "oauth", status: "ok" }],
      usage: { providerId: "google", windows: [], plan: "Gemini Pro" },
    },
  ] satisfies ModelAuthStatusResult["providers"];

  it.each([
    {
      model: { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      selected: "openai:work",
      expected: "Subscription · work@example.com",
      providers: [
        {
          ...authStatus.providers[0]!,
          profileOrder: ["openai:personal"],
          profiles: [
            ...subscriptionProfiles,
            { profileId: "openai:key", type: "api_key", status: "static" },
          ],
        },
      ],
    },
    {
      selected: "google:key",
      expected: "API",
      model: { id: "gemini", name: "Gemini", provider: "google" },
      providers: googleAuthProviders,
    },
    {
      selected: undefined,
      expected: "Gemini Pro",
      model: { id: "gemini", name: "Gemini", provider: "google" },
      providers: googleAuthProviders,
    },
  ] satisfies {
    model: ModelCatalogEntry;
    selected: string | undefined;
    expected: string;
    providers: ModelAuthStatusResult["providers"];
  }[])(
    "labels the selected account after merging provider aliases ($selected)",
    ({ model, selected, providers, expected }) => {
      const { state } = createChatHeaderState({ models: [model] });
      const container = renderModelControls(state, {
        accountSelection: selected
          ? { kind: "personal", label: "Personal account", authProfileId: selected }
          : { kind: "automatic", label: "Automatic" },
        modelAuthStatusResult: { ts: 1, providers },
      });
      expect(
        container
          .querySelector(`[data-chat-model-provider="${model.provider}"] .chat-controls__auth-meta`)
          ?.textContent?.trim(),
      ).toBe(expected);
    },
  );

  it.each([false, true])("does not duplicate a row sign-in warning (%s)", (rowWarning) => {
    const { state } = createChatHeaderState({
      models: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          ...(rowWarning ? { available: false, unavailableReason: "missing-auth" as const } : {}),
        },
      ],
    });
    const container = renderModelControls(state, {
      modelAuthStatusResult: {
        ts: 1,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            status: "expired",
            profiles: [{ profileId: "openai:expired", type: "oauth", status: "expired" }],
          },
        ],
      },
    });
    expect(
      container
        .querySelector('[data-chat-model-provider="openai"]')
        ?.textContent?.includes("Sign-in needed"),
    ).toBe(!rowWarning);
    expect(container.querySelectorAll("[data-chat-model-auth-warning]").length > 0).toBe(
      rowWarning,
    );
  });

  it.each([2])(
    "identifies the selected account even before expanding %i subscription profiles",
    async (count) => {
      const profiles = subscriptionProfiles.slice(0, count).map((profile, index) =>
        Object.assign({}, profile, {
          displayName: index === 0 ? "Sign in with ChatGPT" : "Codex sign-in",
        }),
      );
      const accounts = profiles.map((profile) => ({
        authProfileId: profile.profileId,
        provider: "openai",
        label: profile.displayName,
        authType: profile.type,
        selected: false,
      }));
      const { state } = createChatHeaderState({
        models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
      });
      const request = vi.fn().mockResolvedValue({ profileId: "test", accounts, links: [] });
      const client = createTestGatewayClient(request);
      const container = document.createElement("div");
      const status: ModelAuthStatusResult = {
        ts: 1,
        providers: [{ ...authStatus.providers[0]!, profiles }],
      };
      const selection = {
        kind: "personal" as const,
        label: "Workspace",
        authProfileId: profiles[0]!.profileId,
      };
      const draw = () =>
        renderModelControls(
          state,
          {
            modelAuthStatusResult: status,
            renderAccountSection: (model) =>
              renderChatModelAccountControl({
                owner: state,
                client,
                selection,
                model,
                modelAuthStatusResult: status,
                disabled: false,
                ownsSelection: () => true,
                onSelect: vi.fn(),
                onRequestUpdate: draw,
              }),
          },
          container,
        );
      draw();
      expect(container.querySelector(".chat-controls__account-selection")?.textContent).toBe(
        "work@example.com · Sign in with ChatGPT",
      );
      container.querySelector<HTMLButtonElement>("[data-chat-account-group-toggle]")!.click();
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(container.querySelectorAll("[data-chat-account-option]")).toHaveLength(count),
      );
      for (const [index, row] of [
        ...container.querySelectorAll("[data-chat-account-option]"),
      ].entries()) {
        expect(row.querySelector(".chat-controls__model-option-name")?.textContent?.trim()).toBe(
          profiles[index]!.displayName,
        );
        expect(row.querySelector(".chat-controls__auth-meta")?.textContent?.trim() ?? "").toBe(
          profiles[index]!.email,
        );
        expect(row.textContent).not.toContain(profiles[index]!.profileId);
      }
    },
  );

  it("prepares a large catalog without per-option catalog rescans", () => {
    const size = 400;
    let idReads = 0;
    const models: ModelCatalogEntry[] = Array.from({ length: size }, (_, index) => ({
      get id() {
        idReads += 1;
        return `model-${index}`;
      },
      name: `Model ${index}`,
      provider: "example",
      contextWindow: 128_000,
    }));
    const { state } = createChatHeaderState({
      model: "model-0",
      modelProvider: "example",
      models,
    });
    idReads = 0;
    const container = renderModelControls(state);
    const rows = container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]");
    expect(rows).toHaveLength(size);
    expect(rows[0]?.dataset.chatModelOption).toBe("example/model-0");
    expect(rows[size - 1]?.textContent).toContain(`Model ${size - 1}`);
    expect(rows[size - 1]?.textContent).toContain("128k");
    expect(idReads).toBeLessThan(size * 60);
  });

  afterEach(async () => {
    await i18n.setLocale("en");
  });

  it("retains first-match metadata and canonical labels for duplicate catalog rows", () => {
    const { state } = createChatHeaderState({
      model: "shared",
      modelProvider: "example",
      models: [
        { id: "shared", name: "First label", provider: "example", contextWindow: 111_000 },
        { id: "shared", name: "Last label", provider: "example", contextWindow: 222_000 },
        { id: "gpt-5.5", name: "Legacy label", provider: "codex", contextWindow: 333_000 },
        { id: "gpt-5.5", name: "Canonical label", provider: "openai", contextWindow: 444_000 },
        { id: "gpt-5.5", name: "Later canonical", provider: "openai", contextWindow: 555_000 },
      ],
    });
    const container = renderModelControls(state);
    expect(container.querySelectorAll("[data-chat-model-option]")).toHaveLength(3);
    const shared = container.querySelector('[data-chat-model-option="example/shared"]');
    expect(shared?.textContent).toContain("Last label");
    expect(shared?.textContent).toContain("111k");
    for (const provider of ["codex", "openai"]) {
      const row = container.querySelector(`[data-chat-model-option="${provider}/gpt-5.5"]`);
      expect(row?.textContent).toContain("Canonical label");
      expect(row?.textContent).toContain("444k");
      expect(row?.textContent).not.toContain("555k");
    }
  });

  it.each(["current execution", "previous run", "locked unknown", "unknown"] as const)(
    "keeps the %s model visible during send admission",
    (mode) => {
      const observed = mode === "current execution";
      const unidentified = mode === "locked unknown" || mode === "unknown";
      const sending = unidentified;
      const model = unidentified ? null : observed ? "shared" : "primary";
      const activeModel = observed ? "shared" : "fallback";
      const runIds = observed ? ["current-run"] : undefined;
      const expected = unidentified
        ? "Model pending"
        : observed
          ? "fallback-provider/shared"
          : "Primary";
      const { state } = createChatHeaderState({
        model,
        modelProvider: model ? "example" : null,
        models:
          model === "shared"
            ? [{ id: "shared", name: "Configured model", provider: "example" }]
            : [
                { id: "primary", name: "Primary", provider: "example" },
                {
                  id: unidentified ? "default" : "fallback",
                  name: unidentified ? "Default" : "Fallback",
                  provider: "example",
                },
              ],
      });
      if (!sending) {
        state.chatRunId = "current-run";
        Object.assign(expectDefined(state.sessionsResult?.sessions[0], "selected session"), {
          hasActiveRun: true,
          activeRunIds: runIds,
          activeModel,
          activeModelProvider: runIds ? "fallback-provider" : "example",
        });
      }
      const trigger = getChatModelSelect(
        renderModelControls(
          state,
          unidentified
            ? {
                sending,
                agentDefaultModel: mode === "locked unknown" ? "example/default" : "",
                sessionsResult: null,
                modelSelectionLocked: mode === "locked unknown",
              }
            : { sending },
        ),
      );
      expect(trigger.textContent).toContain(expected);
      if (!unidentified) {
        expect(trigger.dataset.chatSelectValue).toBe(`example/${model}`);
      }
      expect(trigger.getAttribute("aria-label")).toBe("Chat model: " + expected);
      expect(trigger.getAttribute("aria-busy")).toBe("false");
      expect(trigger.querySelector(".btn__spinner")).toBeNull();
      expect(trigger.querySelector(".chat-controls__inline-select-chevron svg")).not.toBeNull();
      if (!runIds) {
        if (!unidentified) {
          expect(trigger.textContent).not.toContain("Model pending");
          expect(trigger.textContent).not.toContain("Fallback");
        } else {
          expect(trigger.querySelector(".chat-controls__model-trigger-skeleton")).toBeNull();
        }
      }
    },
  );

  it.each([false, true])("preserves known selections while the catalog loads (%s)", (known) => {
    const { state } = createChatHeaderState(known ? { model: "gpt-5.6-sol", models: [] } : {});
    const container = renderModelControls(state, {
      modelCatalogState: { hasSnapshot: false, status: "loading" },
      ...(known ? { modelOverrides: { main: null } } : {}),
    });
    const trigger = getChatModelSelect(container);
    expect(trigger.getAttribute("aria-busy")).toBe(String(!known));
    if (known) {
      expect(trigger.textContent).toContain("gpt-5 · openai");
      expect(trigger.getAttribute("aria-label")).toBe("Chat model: gpt-5 · openai");
      expect(trigger.querySelector(".chat-controls__model-trigger-skeleton")).toBeNull();
      expect(container.querySelector('[data-chat-model-catalog-state="loading"]')).not.toBeNull();
      expect(container.querySelector("[data-chat-model-option]")).toBeNull();
    } else {
      expect(trigger.getAttribute("aria-disabled")).toBe("false");
      expect(trigger.querySelector(".chat-controls__model-trigger-skeleton")).not.toBeNull();
      expect(trigger.textContent).not.toContain("Loading models");
      const effort = container.querySelector(".chat-controls__effort-picker");
      expect(effort?.getAttribute("aria-hidden")).toBe("true");
      expect(effort?.hasAttribute("inert")).toBe(true);
    }
  });

  it("shows disabled configured models and model setup when no model has authentication", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      models: [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          contextWindow: 1_000_000,
          available: false,
          unavailableReason: "missing-auth",
        },
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          contextWindow: 1_000_000,
          available: false,
          unavailableReason: "missing-auth",
        },
      ],
    });
    const onModelSetup = vi.fn();
    const container = renderModelControls(state, {
      agentDefaultModel: "openai/gpt-5.6-sol",
      onModelSetup,
    });

    const options = container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]");
    expect([...options].map((option) => option.dataset.chatModelOption)).toEqual([
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-luna",
    ]);
    expect(options[0]?.textContent).toContain("GPT-5.6 Sol");
    expect(options[0]?.textContent).toContain("Default");
    expect([...options].every((option) => !option.disabled)).toBe(true);
    expect([...options].every((option) => option.dataset.chatModelSetup === "true")).toBe(true);
    for (const option of options) {
      const warning = option.querySelector("[data-chat-model-auth-warning]");
      expect(warning?.textContent?.trim()).toBe("Sign-in needed");
      expect(warning?.querySelector("svg")).not.toBeNull();
      expect(option.querySelector(".chat-controls__model-option-meta")).toBeNull();
      expect(option.textContent).not.toContain("1M");
    }
    expect(
      container.querySelector('[data-chat-model-catalog-state="ready"]')?.textContent,
    ).toContain("No models available");
    expect(container.textContent).toContain("Manage models");
    container.querySelector<HTMLButtonElement>('[data-chat-model-setup="true"]')?.click();
    expect(onModelSetup).toHaveBeenCalledOnce();
  });

  it("keeps each alias's auth action tied to its own availability reason", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.6-luna",
      modelProvider: "openai",
      models: [
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          available: false,
          unavailableReason: "missing-auth",
        },
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "codex",
          available: false,
          unavailableReason: "cooldown",
        },
      ],
    });
    const onModelSetup = vi.fn();
    const container = renderModelControls(state, { onModelSetup });
    const cold = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="openai/gpt-5.6-luna"]',
    );
    const recovering = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="codex/gpt-5.6-luna"]',
    );
    expect(cold?.dataset.chatModelSetup).toBe("true");
    expect(recovering?.disabled).toBe(true);
    expect(recovering?.textContent).not.toContain("Sign-in needed");
    recovering?.click();
    expect(onModelSetup).not.toHaveBeenCalled();
    cold?.click();
    expect(onModelSetup).toHaveBeenCalledOnce();
  });

  it("hides the context-window switch when the active session's model declares none", () => {
    const { state } = createChatHeaderState({
      model: "claude-fable-5",
      modelProvider: "claude-cli",
      models: [
        {
          id: "claude-fable-5",
          name: "Claude Fable 5",
          provider: "claude-cli",
          contextWindow: 1_000_000,
          contextWindows: [
            { id: "200k", label: "200K", contextWindow: 200_000 },
            { id: "1m", label: "1M", contextWindow: 1_000_000 },
          ],
          contextWindowDefault: "1m",
        },
      ],
    });
    const session = state.sessionsResult?.sessions[0];
    if (!state.sessionsResult || !session) {
      throw new Error("Expected session fixture");
    }
    // Defaults row advertises selectable windows, but the active session runs an
    // override model without any: the switch must not fall back field-by-field
    // to the defaults row and offer options the session's model cannot honor.
    state.sessionsResult = {
      ...state.sessionsResult,
      defaults: {
        ...state.sessionsResult.defaults,
        contextWindow: "1m",
        contextWindowDefault: "1m",
        contextWindows: state.chatModelCatalog[0]?.contextWindows,
      },
      sessions: [{ ...session, model: "gpt-5.6-luna", modelProvider: "openai" }],
    };
    const container = renderModelControls(state, {});
    const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
    if (!picker) {
      throw new Error("Expected model picker");
    }
    picker.open = true;
    picker.dispatchEvent(new Event("toggle"));

    expect(container.querySelector("[data-chat-context-window-toggle]")).toBeNull();
    expect(container.querySelector("[data-chat-model-context-badge]")).toBeNull();
  });

  it("clears a session pin when its matching default is unavailable", () => {
    const model = "gpt-5";
    const { state } = createChatHeaderState({
      model,
      modelProvider: "openai",
      modelOverrideSource: "user",
      models: [
        {
          id: model,
          name: "GPT-5",
          provider: "openai",
          available: false,
          unavailableReason: "missing-auth" as const,
        },
        ...createOpenAiModelCatalog(),
      ],
    });
    const onModelSelect = vi.fn(async () => true);
    const onModelSetup = vi.fn();
    const container = renderModelControls(state, { onModelSelect, onModelSetup });
    document.body.append(container);
    const defaultRow = container.querySelector<HTMLButtonElement>(
      `[data-chat-model-option="openai/${model}"]`,
    );
    expect(defaultRow?.dataset.chatModelDefault).toBe("true");
    expect(defaultRow?.getAttribute("aria-selected")).toBe("true");
    expect(defaultRow?.disabled).toBe(false);
    defaultRow?.click();
    expect(onModelSelect).toHaveBeenCalledWith("", "main", null);
    expect(onModelSetup).not.toHaveBeenCalled();
    container.remove();
  });

  it("groups models and preserves ranked keyboard selection through catalog replacement", async () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
        { id: "gemini-2.5-pro", name: "Anth model", provider: "google" },
        {
          id: "unavailable",
          name: "Anth unavailable",
          provider: "google",
          available: false,
          unavailableReason: "cooldown",
        },
      ],
    });
    const onModelSelect = vi.fn(async () => true);
    const onProviderSettings = vi.fn();
    const callbacks = { onModelSelect, onProviderSettings };
    const container = renderModelControls(state, callbacks);
    document.body.append(container);

    const providerHeadings = Array.from(
      container.querySelectorAll<HTMLElement>("[data-chat-model-provider]"),
    );
    expect(
      providerHeadings.map((heading) =>
        heading.querySelector(".chat-controls__provider-label")?.textContent?.trim(),
      ),
    ).toEqual(["OpenAI", "Anthropic", "Google"]);
    const providerSettings = providerHeadings[0]?.querySelector<HTMLButtonElement>(
      "[data-chat-model-provider-settings]",
    );
    expect(providerSettings?.getAttribute("aria-label")).toBe("Configure models");
    expect(providerSettings?.closest("openclaw-tooltip")).toBeNull();
    expect(providerSettings?.closest('[role="listbox"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).every(
        (option) => option.closest('[role="listbox"]') !== null,
      ),
    ).toBe(true);
    providerSettings?.click();
    expect(onProviderSettings).toHaveBeenCalledExactlyOnceWith("openai");
    const anthropicModels = container.querySelector<HTMLElement>(
      '[data-chat-model-provider-group="anthropic"]',
    );
    expect(anthropicModels?.textContent).toContain("Claude Sonnet 4.6");
    const details = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
    const search = container.querySelector<HTMLInputElement>("[data-chat-model-search]");
    details!.open = true;
    expect(container.querySelector("[data-chat-model-selection-target]")).toBeNull();
    search!.value = "anth";
    search!.dispatchEvent(new InputEvent("input", { bubbles: true }));

    const visibleOptions = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"),
    ).filter((option) => !option.hidden);
    expect(visibleOptions.map((option) => option.dataset.chatModelOption)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "google/gemini-2.5-pro",
      "google/unavailable",
    ]);
    expect(visibleOptions[1]?.hasAttribute("data-chat-model-highlighted")).toBe(true);
    expect(visibleOptions[2]?.disabled).toBe(true);
    expect(
      visibleOptions[2]?.querySelector(
        "[data-chat-model-shortcut][data-chat-model-shortcut-number]",
      ),
    ).toBeNull();
    expect(
      visibleOptions[1]
        ?.querySelector("[data-chat-model-shortcut]")
        ?.getAttribute("data-chat-model-shortcut-number"),
    ).toBe("1");
    expect(
      visibleOptions[0]?.querySelector(".chat-controls__model-option-provider"),
    ).not.toBeNull();

    search!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const highlighted = container.querySelector<HTMLButtonElement>("[data-chat-model-highlighted]");
    expect(highlighted).toBe(visibleOptions[0]);
    expect(highlighted?.id).not.toBe("");
    expect(search?.getAttribute("aria-activedescendant")).toBe(highlighted?.id);

    state.chatModelCatalog = [
      ...state.chatModelCatalog,
      { id: "new-match", name: "Anth new", provider: "openai" },
    ];
    renderModelControls(state, { ...callbacks, modelPickerOpen: true }, container);
    await Promise.resolve();
    expect(container.querySelector("[data-chat-model-search]")).toBe(search);
    expect(search?.value).toBe("anth");
    expect(container.querySelector("[data-chat-model-highlighted]")).toBe(highlighted);
    expect(search?.getAttribute("aria-activedescendant")).toBe(highlighted?.id);

    search!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onModelSelect).toHaveBeenCalledWith("anthropic/claude-sonnet-4-6", "main", undefined);
    expect(details?.open).toBe(false);

    onModelSelect.mockClear();
    details!.dispatchEvent(new Event("toggle"));
    details!.open = true;
    container
      .querySelector<HTMLButtonElement>(
        '[data-chat-model-provider-group="anthropic"] [data-chat-model-provider-toggle]',
      )!
      .click();
    details!.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
    expect(onModelSelect).toHaveBeenCalledExactlyOnceWith(
      "anthropic/claude-sonnet-4-6",
      "main",
      undefined,
    );
    expect(details?.open).toBe(false);
    container.remove();
  });

  it("matches the default model by its localized marker and canonical reference", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.5", name: "Chat Model", provider: "openai" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
      ],
    });
    state.sessionsResult = createSessionsListResult({
      model: "gpt-5.5",
      modelProvider: "openai",
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai",
    });
    const container = renderModelControls(state);
    const search = container.querySelector<HTMLInputElement>("[data-chat-model-search]");

    for (const query of ["default", "gpt-5.5", "OPENAI/GPT-5.5"]) {
      search!.value = query;
      search!.dispatchEvent(new InputEvent("input", { bubbles: true }));

      const visibleOptions = container.querySelectorAll("[data-chat-model-option]:not([hidden])");
      expect(visibleOptions, query).toHaveLength(1);
      expect(visibleOptions[0]?.getAttribute("data-chat-model-default")).toBe("true");
    }
  });

  it("leaves digit keys to nested controls and selects the numbered row from the picker", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
      ],
    });
    const onModelSelect = vi.fn(async () => true);
    const container = renderModelControls(state, {
      onModelSelect,
    });
    document.body.append(container);

    const details = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
    const search = container.querySelector<HTMLInputElement>("[data-chat-model-search]");
    details!.open = true;
    search!.value = "claude";
    search!.dispatchEvent(new InputEvent("input", { bubbles: true }));

    search!.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(onModelSelect).not.toHaveBeenCalled();
    expect(search!.value).toBe("claude");

    const nestedPicker = document.createElement("wa-dropdown");
    const nestedTrigger = document.createElement("button");
    nestedPicker.append(nestedTrigger);
    details!.append(nestedPicker);
    nestedTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(onModelSelect).not.toHaveBeenCalled();

    details!.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(onModelSelect).toHaveBeenCalledWith("anthropic/claude-sonnet-4-6", "main", undefined);
    container.remove();
  });

  it.each([
    ["an implicit default runtime change", false, "openclaw", undefined, true],
    ["a pending same-model switch", true, "codex", "codex", false],
    ["a different session runtime", false, "openclaw", "codex", false],
    ["missing session runtime provenance", false, undefined, "codex", false],
  ] as const)(
    "does not pair a stale session budget with %s",
    (_name, modelSwitching, sessionRuntimeId, optionRuntimeId, implicitDefault) => {
      const { state } = createChatHeaderState({
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        models: [
          {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            provider: "openai",
            contextWindow: 1_050_000,
            ...(optionRuntimeId
              ? { agentRuntime: { id: optionRuntimeId, source: "model" as const } }
              : {}),
          },
        ],
      });
      state.sessionsResult = createSessionsResultFromRows([
        {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          ...(sessionRuntimeId
            ? { agentRuntime: { id: sessionRuntimeId, source: "session" as const } }
            : {}),
          contextTokens: 272_000,
        },
      ]);
      if (implicitDefault) {
        state.sessionsResult.defaults = {
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          contextTokens: 1_000_000,
          agentRuntime: { id: "codex", source: "implicit" },
        };
      }
      const container = renderModelControls(
        state,
        implicitDefault
          ? {}
          : {
              modelOverrides: { main: "openai/gpt-5.6-sol" },
              modelSwitching,
            },
      );
      const option = container.querySelector<HTMLButtonElement>(
        '[data-chat-model-option="openai/gpt-5.6-sol"]',
      );
      expect(option?.querySelector(".chat-controls__model-option-meta")?.textContent).toBe(
        optionRuntimeId ? "1M · Codex" : "1M",
      );
      if (implicitDefault) {
        expect(option?.textContent).not.toContain("272k active");
      }
    },
  );

  it("uses the session provider for slash-containing raw model ids", () => {
    const { state } = createChatHeaderState();
    state.chatModelCatalog = [
      {
        id: "google/gemma-4-26b-a4b-it",
        name: "Gemma 4",
        provider: "google",
        agentRuntime: { id: "openclaw", source: "implicit" },
      },
      {
        id: "google/gemma-4-26b-a4b-it",
        name: "Gemma 4",
        provider: "openrouter",
        contextWindow: 1_000_000,
        agentRuntime: { id: "openclaw", source: "implicit" },
      },
    ];
    state.sessionsResult = createSessionsListResult({
      model: "google/gemma-4-26b-a4b-it",
      modelProvider: "openrouter",
      defaultsModel: "google/gemma-4-26b-a4b-it",
      defaultsProvider: "openrouter",
    });
    state.sessionsResult.sessions[0]!.agentRuntime = {
      id: "openclaw",
      source: "implicit",
    };
    state.sessionsResult.sessions[0]!.contextTokens = 272_000;
    const container = renderModelControls(state);

    const providerButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-provider]"),
    );
    expect(
      providerButtons.map((button) =>
        button.querySelector(".chat-controls__provider-label")?.textContent?.trim(),
      ),
    ).toEqual(["OpenRouter", "Google"]);
    expect(
      container.querySelector<HTMLElement>('[data-chat-model-provider-group="google"]')
        ?.textContent,
    ).toContain("Gemma 4");
    expect(
      container.querySelector<HTMLElement>('[data-chat-model-provider-group="openrouter"]')
        ?.textContent,
    ).toContain("272k active · 1M max");
  });

  it("uses selected global session model and speed instead of agent defaults", () => {
    const { state } = createChatHeaderState({
      model: "gpt-default",
      modelProvider: "openai",
      models: [
        { id: "gpt-default", name: "Default GPT", provider: "openai" },
        { id: "gpt-session", name: "Session GPT", provider: "openai" },
      ],
    });
    state.sessionsResult = createSessionsListResult({
      defaultsModel: "gpt-default",
      defaultsProvider: "openai",
      model: "gpt-session",
      modelProvider: "openai",
      modelOverrideSource: "user",
    });
    const selectedSession = expectDefined(state.sessionsResult.sessions[0], "selected session");
    selectedSession.key = "global";
    selectedSession.kind = "global";
    selectedSession.fastMode = true;
    selectedSession.effectiveFastMode = true;

    const container = renderModelControls(state, {
      agentDefaultModel: "openai/gpt-default",
      sessionKey: "agent:work:main",
      selectedSession,
    });

    expect(getChatModelSelect(container).dataset.chatSelectValue).toBe("openai/gpt-session");
    expect(
      container
        .querySelector('[data-chat-thinking-select="true"]')
        ?.getAttribute("data-chat-fast-mode"),
    ).toBe("true");
  });

  it("uses a unique catalog provider before an unrelated stale session hint", () => {
    const { state } = createChatHeaderState({
      model: "moonshotai/kimi-k2.5",
      modelProvider: "zai",
      models: [
        {
          id: "moonshotai/kimi-k2.5",
          name: "Kimi K2.5",
          provider: "nvidia",
        },
      ],
    });
    const container = renderModelControls(state, {
      modelOverrides: { main: "moonshotai/kimi-k2.5" },
    });

    const providers = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-provider]"),
    ).map((button) => button.dataset.chatModelProvider);
    expect(providers).toContain("nvidia");
    expect(providers).not.toContain("zai");
    expect(
      container.querySelector<HTMLElement>('[data-chat-model-provider-group="nvidia"]')?.hidden,
    ).toBe(false);
  });

  it("applies model, reasoning, and speed for the session that opened the picker", async () => {
    const { state } = createReasoningHeaderState({
      models: createOpenAiModelCatalog(),
    });
    const onModelSelect = vi.fn(async () => true);
    const onThinkingSelect = vi.fn(async () => true);
    const onFastModeSelect = vi.fn(async () => true);
    const container = renderModelControls(state, {
      onFastModeSelect,
      onModelSelect,
      onThinkingSelect,
    });

    const modelOption = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"),
    ).find(
      (button) =>
        button.getAttribute("aria-selected") === "false" && button.dataset.chatModelOption !== "",
    );
    expect(modelOption).toBeInstanceOf(HTMLButtonElement);
    modelOption?.click();
    expect(onModelSelect).toHaveBeenCalledWith(
      modelOption?.dataset.chatModelOption,
      "main",
      undefined,
    );

    const slider = getThinkingSlider(container);
    expect(slider).toBeInstanceOf(HTMLInputElement);
    if (slider) {
      slider.value = "0";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      expect(slider.getAttribute("aria-valuetext")).toBe("Low");
      expect(getThinkingReasoningValueLabel(container)).toBe("Low");
      slider.dispatchEvent(new Event("change", { bubbles: true }));
      expect(getThinkingReasoningValueLabel(container)).toBe("High");

      slider.value = "0";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("pointercancel"));
      expect(slider.value).toBe(String(getThinkingSliderValues(container).indexOf("high")));
      expect(getThinkingReasoningValueLabel(container)).toBe("High");
    }
    expect(onThinkingSelect).toHaveBeenCalledWith("low", "main");

    const speedToggle = container.querySelector<HTMLButtonElement>('[data-chat-speed-option="on"]');
    expect(speedToggle).toBeInstanceOf(HTMLButtonElement);
    await waitForFast(() => expect(speedToggle?.disabled).toBe(false));
    speedToggle?.click();
    expect(onFastModeSelect).toHaveBeenCalledWith("on", "main");
  });

  it("orders model-dependent patches after a pending model switch", async () => {
    const modelPatch = createDeferred<SessionPatchResult | null>();
    const thinkingUpdate = createDeferred<SessionPatchResult | null>();
    const patches: Array<Record<string, unknown>> = [];
    const patchResult: SessionPatchResult = {
      ok: true,
      path: "",
      key: "main",
      entry: { sessionId: "main" },
    };
    const host = createSettingsLaneHost(
      async (_key: string, patch: Record<string, unknown>, options?: SessionPatchOptions) => {
        if (options?.waitFor) {
          await options.waitFor;
        }
        patches.push(patch);
        if (Object.hasOwn(patch, "model")) {
          return modelPatch.promise;
        }
        if (Object.hasOwn(patch, "thinkingLevel")) {
          return thinkingUpdate.promise;
        }
        return patchResult;
      },
    );

    const modelSwitch = switchChatModel(host, "openai/gpt-5.6-sol");
    const thinkingPatch = switchChatThinkingLevel(host, "ultra");
    const fastModePatch = switchChatFastMode(host, "on");
    const laterModelSwitch = switchChatModel(host, "google/gemini-3-pro");

    expect(patches).toEqual([{ model: "openai/gpt-5.6-sol" }]);
    modelPatch.resolve(patchResult);
    await expect(modelSwitch).resolves.toBe(true);
    await waitForFast(() => expect(patches).toHaveLength(2));
    expect(patches.at(-1)).toEqual({ thinkingLevel: "ultra" });
    thinkingUpdate.resolve(patchResult);
    await expect(thinkingPatch).resolves.toBe(true);
    await waitForFast(() => expect(patches).toHaveLength(4));
    await expect(Promise.all([fastModePatch, laterModelSwitch])).resolves.toEqual([true, true]);
    expect(patches.at(-1)).toEqual({ model: "google/gemini-3-pro" });
    expect(patches).toEqual([
      { model: "openai/gpt-5.6-sol" },
      { thinkingLevel: "ultra" },
      { fastMode: true },
      { model: "google/gemini-3-pro" },
    ]);
  });

  it("keeps reconciliation inside the session settings lane", async () => {
    const reconciliationStarted = createDeferred();
    const releaseReconciliation = createDeferred();
    const patches: Array<Record<string, unknown>> = [];
    const patchResult: SessionPatchResult = {
      ok: true,
      path: "",
      key: "main",
      entry: { sessionId: "main" },
    };
    const host = createSettingsLaneHost(
      async (_key: string, patch: Record<string, unknown>, options?: SessionPatchOptions) => {
        if (options?.waitFor) {
          await options.waitFor;
        }
        patches.push(patch);
        return patchResult;
      },
      async () => {
        reconciliationStarted.resolve();
        await releaseReconciliation.promise;
      },
    );

    const modelSwitch = switchChatModel(host, "openai/gpt-5.6-sol");
    await reconciliationStarted.promise;
    const thinkingPatch = switchChatThinkingLevel(host, "ultra");
    await Promise.resolve();
    expect(patches).toEqual([{ model: "openai/gpt-5.6-sol" }]);

    releaseReconciliation.resolve();
    await expect(Promise.all([modelSwitch, thinkingPatch])).resolves.toEqual([true, true]);
    expect(patches).toEqual([{ model: "openai/gpt-5.6-sol" }, { thinkingLevel: "ultra" }]);
  });

  it("validates queued settings independently after a model switch fails", async () => {
    const modelPatch = createDeferred<SessionPatchResult | null>();
    const patches: Array<Record<string, unknown>> = [];
    const host = createSettingsLaneHost(
      async (_key: string, patch: Record<string, unknown>, options?: SessionPatchOptions) => {
        if (options?.waitFor) {
          await options.waitFor;
        }
        patches.push(patch);
        return modelPatch.promise;
      },
    );

    const modelSwitch = switchChatModel(host, "openai/gpt-5.6-sol");
    const thinkingPatch = switchChatThinkingLevel(host, "ultra");
    modelPatch.resolve(null);

    await expect(modelSwitch).resolves.toBe(false);
    await expect(thinkingPatch).resolves.toBe(false);
    expect(patches).toEqual([{ model: "openai/gpt-5.6-sol" }, { thinkingLevel: "ultra" }]);
    expect(host.chatThinkingLevel).toBe("high");
  });

  it.each([
    { sessionKey: "global", keepsVisibleOwner: false },
    { sessionKey: "agent:work:main", keepsVisibleOwner: true },
  ])(
    "keeps model errors bound to the captured conversation ($sessionKey)",
    async ({ sessionKey, keepsVisibleOwner }) => {
      const modelPatch = createDeferred<null>();
      const { state } = createChatHeaderState();
      const sessions = state.sessions;
      const patch = vi.spyOn(sessions, "patch").mockImplementation(async () => modelPatch.promise);
      const host = {
        ...state,
        assistantAgentId: "work",
        agentsList: { defaultId: "main", mainKey: "main", scope: "global" },
        sessionKey,
        chatModelCatalog: [],
        chatModelSwitchPromises: {},
        chatError: null,
        sessions,
        sessionsResult: createSessionsResultFromRows([
          {
            key: sessionKey,
            kind: "direct",
            updatedAt: 1,
            model: "gpt-agent-a-old",
            modelProvider: "openai",
          },
        ]),
      } satisfies Parameters<typeof switchChatModel>[0];

      const switching = switchChatModel(host, "openai/gpt-agent-a-new");
      await waitForFast(() => expect(patch).toHaveBeenCalledOnce());
      // Bare global follows the selector; an explicit agent key retains its conversation owner.
      host.assistantAgentId = "main";
      modelPatch.reject(new Error("agent A patch failed"));

      await expect(switching).resolves.toBe(false);
      if (keepsVisibleOwner) {
        expect(host.lastError).toContain("agent A patch failed");
        expect(host.chatError).toContain("agent A patch failed");
      } else {
        expect(host.lastError ?? null).toBeNull();
        expect(host.chatError ?? null).toBeNull();
      }
    },
  );

  it("keeps the newest speed selection when an older patch fails late", async () => {
    const pendingPatches: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    const operations: Promise<boolean>[] = [];
    let canonical: GatewaySessionRow = {
      key: "main",
      agentId: "main",
      sessionId: "main",
      kind: "direct",
      updatedAt: 1,
      fastMode: false,
      effectiveFastMode: false,
    };
    const host = makeChatHost({
      sessionKey: "main",
      hello: {
        ...sessionMutationGatewayHello(),
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "agent:main:main",
          },
        },
      },
      sessionsResult: createSessionsResultFromRows([canonical]),
      requestHandlers: {
        "sessions.list": () => createSessionsResultFromRows([canonical]),
        "sessions.patch": (params: Record<string, unknown>) => {
          const fastMode = params.fastMode;
          if (typeof fastMode !== "boolean") {
            throw new Error("Expected the speed race to send a boolean fastMode");
          }
          return new Promise<SessionPatchResult>((resolve, reject) => {
            pendingPatches.push({
              resolve: () => {
                canonical = {
                  ...canonical,
                  fastMode,
                  effectiveFastMode: fastMode,
                  updatedAt: (canonical.updatedAt ?? 0) + 1,
                };
                resolve({
                  ok: true,
                  path: "",
                  key: "main",
                  entry: { sessionId: "main", fastMode, updatedAt: canonical.updatedAt ?? 1 },
                });
              },
              reject,
            });
          });
        },
      },
    });
    const projectSessions = (state: typeof host.sessions.state) => {
      host.sessionsResult = state.result;
      host.sessionsResultAgentId = state.agentId;
    };
    projectSessions(host.sessions.state);
    const stop = host.sessions.subscribe(projectSessions);
    onTestFinished(async () => {
      stop();
      host.sessions.dispose();
      for (const patch of pendingPatches) {
        patch.resolve();
      }
      await Promise.allSettled(operations);
    });

    const first = switchChatFastMode(host, "on");
    operations.push(first);
    await waitForFast(() => expect(pendingPatches).toHaveLength(1));
    const second = switchChatFastMode(host, "off");
    operations.push(second);

    pendingPatches[0]?.reject(new Error("boom"));
    await expect(first).resolves.toBe(false);
    await waitForFast(() => expect(pendingPatches).toHaveLength(2));
    pendingPatches[1]?.resolve();
    await expect(second).resolves.toBe(true);

    // The newer selection keeps its own validation turn after the older failure.
    const row = host.sessionsResult?.sessions.find((entry) => entry.key === "main");
    expect(row?.fastMode).toBe(false);
  });

  it.each([false, true])(
    "keeps an unanchored thinking default visible with missing session=%s",
    async (omitSessionFromList) => {
      const { state, request } = createChatHeaderState(
        omitSessionFromList
          ? {
              defaultsThinkingDefault: "adaptive",
              omitSessionFromList,
            }
          : { model: "gemma4:hermes-e4b", modelProvider: "ollama", thinkingDefault: "adaptive" },
      );
      const owner = omitSessionFromList
        ? expectDefined(state.sessionsResult, "sessions").defaults
        : expectDefined(state.sessionsResult?.sessions[0], "session");
      owner.thinkingLevels = ["off", "minimal", "low", "medium", "high"].map((id) => ({
        id,
        label: id,
      }));
      const container = renderModelControls(state);
      expect(getChatThinkingValue(getThinkingSelect(container))).toBe("");
      expect(getThinkingReasoningValueLabel(container)).toBe("Adaptive");
      if (!omitSessionFromList) {
        expect(getThinkingSliderValues(container)).not.toContain("adaptive");
        const slider = getThinkingSlider(container);
        expect(slider?.classList.contains("chat-controls__reasoning-range--unanchored")).toBe(true);
        slider?.click();
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith("sessions.patch", {
            key: "main",
            thinkingLevel: "off",
          }),
        );
      }
    },
  );

  it.each([false, true])(
    "selects a single thinking level only when not inherited (%s)",
    async (inherited) => {
      const { state, request } = createChatHeaderState();
      const thinkingLevels = [{ id: "adaptive", label: "adaptive" }];
      state.sessionsResult = inherited
        ? createSessionsListResult({
            model: "gpt-5",
            modelProvider: "openai",
            defaultsThinkingDefault: "adaptive",
            defaultsThinkingLevels: thinkingLevels,
          })
        : createSessionsResultFromRows([
            {
              key: "main",
              kind: "direct",
              modelProvider: "openai",
              model: "gpt-5",
              thinkingLevels,
              updatedAt: 1,
            },
          ]);
      const container = renderModelControls(state);
      expect(getThinkingSlider(container)).toBeNull();
      const only = container.querySelector<HTMLButtonElement>(
        '[data-chat-thinking-option="adaptive"]',
      );
      expect(only).toBeInstanceOf(HTMLButtonElement);
      expect(only?.getAttribute("aria-pressed")).toBe(String(inherited));
      only?.click();
      if (inherited) {
        expect(request).not.toHaveBeenCalled();
      } else {
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith("sessions.patch", {
            key: "main",
            thinkingLevel: "adaptive",
          }),
        );
      }
    },
  );
});

describe("right-click Reply", () => {
  const replyTarget = { messageId: "msg-1", text: "quoted", senderLabel: "User" };
  const renderReply = (overrides: Partial<ChatProps> = {}) =>
    renderChatView({ replyTarget, ...overrides });

  function createReplyPane(paneId: string, draft: string, quote: string) {
    const container = document.createElement("div");
    const host: Pick<ChatProps, "draft" | "replyTarget"> = {
      draft,
      replyTarget: { ...replyTarget, messageId: `${paneId}-message`, text: quote },
    };
    const onSend = vi.fn();
    const onAbort = vi.fn();
    const onDraftChange = vi.fn((next: string) => {
      host.draft = next;
    });
    const onRequestUpdate = vi.fn(() => redraw());
    const onClearReply = vi.fn(() => {
      host.replyTarget = null;
      redraw();
    });
    function redraw() {
      renderChatInto(container, {
        paneId,
        sessionKey: `agent:main:${paneId}`,
        draft: host.draft,
        getDraft: () => host.draft,
        replyTarget: host.replyTarget,
        canAbort: true,
        runActive: true,
        onDraftChange,
        onRequestUpdate,
        onClearReply,
        onSend,
        onAbort,
      });
    }
    return {
      container,
      host,
      redraw,
      onDraftChange,
      onRequestUpdate,
      onClearReply,
      onSend,
      onAbort,
      dispose: () => {
        render(null, container);
        container.remove();
        resetChatViewState(paneId, container);
      },
    };
  }

  function dispatchContextMenu(target: EventTarget): MouseEvent {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  function getContextMenuAction(name: string): HTMLButtonElement {
    const matches = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '.chat-reply-context-menu button[role="menuitem"]',
      ),
    ].filter((button) => button.textContent?.trim() === name);
    expect(matches).toHaveLength(1);
    const button = expectDefined(matches[0], `${name} context-menu action`);
    expect(button.getAttribute("aria-label")).toBeNull();
    expect(button.getAttribute("aria-labelledby")).toBeNull();
    return button;
  }

  function renderChatBubble(
    chatOverrides: Partial<ChatProps> = {},
    bubbleOverrides: Parameters<typeof appendChatBubble>[1] = {},
  ) {
    const container = renderChatView(chatOverrides);
    return { container, ...appendChatBubble(container, bubbleOverrides) };
  }

  it.each([false, true])(
    "keeps context actions tied to message ownership and active run=%s",
    (working) => {
      const onRewindMessage = working ? vi.fn() : vi.fn().mockResolvedValue(true);
      const onForkMessage = vi.fn();
      const onCopy = vi.fn();
      const { bubble, group } = renderChatBubble(
        {
          onRewindMessage,
          onForkMessage,
          ...(working ? { canAbort: true, runActive: true } : { onSetReply: vi.fn() }),
        },
        {
          entryId: "persisted-user",
          groupClass: "chat-group user",
          ...(working ? {} : { messageId: "message-1", text: "hello" }),
        },
      );
      if (!working) {
        group.dataset.chatRowKey = "group:user:persisted";
      }

      dispatchContextMenu(bubble);
      if (working) {
        expect(getContextMenuAction("Rewind to here").disabled).toBe(true);
        expect(getContextMenuAction("Fork from here").disabled).toBe(true);
        expect(getContextMenuAction("Rewind to here").closest("openclaw-tooltip")?.content).toBe(
          "Rewind is unavailable while the agent is working",
        );
        return;
      }

      const labels = [...document.querySelectorAll(".chat-reply-context-menu button")].map(
        (button) => button.textContent?.trim(),
      );
      expect(labels).toEqual(["Reply", "Rewind to here", "Copy as markdown", "Fork from here"]);
      getContextMenuAction("Fork from here").click();
      expect(onForkMessage).toHaveBeenCalledWith("persisted-user");

      group.className = "chat-group assistant";
      const siblingActionOwner = document.createElement("div");
      siblingActionOwner.dataset.messageActionsFor = "message-0";
      const copyButton = document.createElement("button");
      copyButton.className = "chat-copy-btn";
      copyButton.addEventListener("click", onCopy);
      const actionOwner = document.createElement("div");
      actionOwner.dataset.messageActionsFor = "message-1";
      actionOwner.append(copyButton);
      group.append(siblingActionOwner, actionOwner);
      dispatchContextMenu(bubble);
      expect(
        [...document.querySelectorAll(".chat-reply-context-menu button")].map((button) =>
          button.textContent?.trim(),
        ),
      ).toEqual(["Reply", "Copy as markdown"]);
      expect(
        document.querySelector('.chat-reply-context-menu [aria-label="Reply to message"] svg'),
      ).toBeNull();

      dispatchContextMenu(bubble);
      getContextMenuAction("Copy as markdown").click();
      expect(onCopy).toHaveBeenCalledOnce();
    },
  );

  it("copies commentary without offering Reply for another bubble's frame actions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onSetReply = vi.fn();
    const { bubble, group } = renderChatBubble(
      { onSetReply },
      { messageId: "commentary", text: "Intermediate commentary" },
    );
    const actionOwner = document.createElement("div");
    actionOwner.dataset.messageActionsFor = "terminal";
    group.append(actionOwner);
    group.dataset.chatRowKey = 'agent-run:["run-1","send:send-1"]';

    const event = dispatchContextMenu(bubble);

    expect(event.defaultPrevented).toBe(true);
    expect(
      [...document.querySelectorAll(".chat-reply-context-menu button")].map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Copy as markdown"]);
    getContextMenuAction("Copy as markdown").click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("Intermediate commentary"));
    expect(onSetReply).not.toHaveBeenCalled();
  });

  it("dismisses an inline confirmation before opening the reply context menu", () => {
    const container = renderChatView({ onSetReply: vi.fn() });
    document.body.appendChild(container);
    const section = container.querySelector<HTMLElement>(".chat")!;
    const confirmationOwner = document.createElement("span");
    confirmationOwner.className = "chat-confirm-wrap";
    const confirmationTrigger = document.createElement("button");
    confirmationOwner.appendChild(confirmationTrigger);
    section.appendChild(confirmationOwner);
    window.localStorage.removeItem("openclaw:skip-rewind-confirm");
    chatMessageConfirmation.openChatRewindConfirmation(confirmationTrigger, vi.fn());
    const confirmation = document.querySelector<HTMLElement>(".chat-confirm-popover");
    const { bubble } = appendChatBubble(container, { text: "open message actions" });

    try {
      expect(confirmation?.isConnected).toBe(true);
      dispatchContextMenu(bubble);

      expect(confirmation?.isConnected).toBe(false);
      expect(document.querySelector(".chat-reply-context-menu")).not.toBeNull();
    } finally {
      chatMessageConfirmation.dismissConfirmedActionPopovers(confirmationOwner);
      confirmationOwner.remove();
      container.remove();
    }
  });

  it("keeps Reply and composer focus available when the pane rerenders with its menu open", () => {
    const onSetReply = vi.fn();
    const transcript = createTestTranscript();
    const { container, bubble } = renderChatBubble(
      { onSetReply, transcript },
      {
        messageId: "msg-stable-1",
        senderLabel: "User",
        text: "hello world",
      },
    );
    document.body.appendChild(container);
    transcript.hostConnected();

    try {
      dispatchContextMenu(bubble);

      const menu = document.querySelector(".chat-reply-context-menu");
      expect(menu).not.toBeNull();
      renderChatInto(container, { onSetReply, transcript, draft: "A draft update" });
      menu!.querySelector("button")!.click();

      expect(onSetReply).toHaveBeenCalledTimes(1);
      const target = itemAt(
        itemAt(onSetReply.mock.calls, 0, "reply callback call"),
        0,
        "reply target",
      );
      expect(target.messageId).toBe("msg-stable-1");
      expect(target.text).toBe("hello world");
      expect(target.senderLabel).toBe("User");
      expect(document.activeElement).toBe(
        container.querySelector(".agent-chat__composer-combobox textarea"),
      );
    } finally {
      transcript.hostDisconnected();
      render(null, container);
      container.remove();
    }
  });

  it.each(["linked image", "streaming", "absent callback"] as const)(
    "keeps the native context menu for %s",
    (mode) => {
      const { bubble } = renderChatBubble(
        mode === "linked image"
          ? { onSetReply: vi.fn() }
          : mode === "absent callback"
            ? {
                messages: [{ role: "user", content: "hello", timestamp: 1 }],
              }
            : {},
        mode === "absent callback"
          ? {}
          : { text: mode === "streaming" ? "still streaming" : "hello world" },
      );
      let target: HTMLElement = bubble;
      if (mode === "linked image") {
        const preview = bubble.appendChild(document.createElement("div"));
        render(
          html`<a href="https://example.com"><img src="/example.png" alt="Example" /></a>`,
          preview,
        );
        target = expectDefined(preview.querySelector("img"), "linked image");
      } else if (mode === "streaming") {
        bubble.classList.add("streaming");
      }
      expect(dispatchContextMenu(target).defaultPrevented).toBe(false);
      expect(document.querySelector(".chat-reply-context-menu")).toBeNull();
    },
  );

  it.each(["Escape", "owner reset"] as const)(
    "dismisses portaled Rewind confirmation through %s",
    (mode) => {
      const flushFrames = stubAnimationFrames();
      const removeDocumentListener = vi.spyOn(document, "removeEventListener");
      const removeWindowListener = vi.spyOn(window, "removeEventListener");
      const onRewindMessage = vi.fn();
      const { bubble } = renderChatBubble(
        { paneId: "pane-a", onRewindMessage },
        { entryId: "persisted-user", groupClass: "chat-group user", text: "hello" },
      );
      dispatchContextMenu(bubble);
      flushFrames();
      const rewindButton = getContextMenuAction("Rewind to here");
      expect(rewindButton).toBeInstanceOf(HTMLButtonElement);
      rewindButton.click();
      flushFrames();
      if (mode === "Escape") {
        const cancel = document.querySelector<HTMLButtonElement>(".chat-confirm-popover__cancel");
        expect(cancel).toBeInstanceOf(HTMLButtonElement);
        expect(document.activeElement).toBe(cancel);
        const confirmationEscape = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        });
        cancel!.dispatchEvent(confirmationEscape);
        expect(confirmationEscape.defaultPrevented).toBe(true);
        expect(document.querySelector(".chat-confirm-popover")).toBeNull();
        expect(document.querySelector(".chat-reply-context-menu")).not.toBeNull();
        expect(document.activeElement).toBe(rewindButton);
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      } else {
        resetThreadPresentation("pane-b");
        expect(document.querySelector(".chat-reply-context-menu")).not.toBeNull();
        expect(document.querySelector(".chat-confirm-popover")).not.toBeNull();
        resetThreadPresentation("pane-a");
        expect(document.querySelector(".chat-confirm-popover")).toBeNull();
        expect(onRewindMessage).not.toHaveBeenCalled();
        expect(removeDocumentListener).toHaveBeenCalledWith("click", expect.any(Function), true);
        expect(removeWindowListener).toHaveBeenCalledWith("keydown", expect.any(Function), true);
      }
      expect(document.querySelector(".chat-reply-context-menu")).toBeNull();
    },
  );

  it("dismisses the reply context menu before a later context menu opens", () => {
    const flushFrames = stubAnimationFrames();
    const { bubble } = renderChatBubble({ onSetReply: vi.fn() }, { text: "hello world" });
    dispatchContextMenu(bubble);
    flushFrames();
    expect(document.querySelector(".chat-reply-context-menu")).not.toBeNull();

    dispatchContextMenu(document.body);

    expect(document.querySelector(".chat-reply-context-menu")).toBeNull();
  });

  it("renders a dismissible reply preview without splitting an emoji at the limit", () => {
    const onClearReply = vi.fn();
    const container = renderReply({
      replyTarget: {
        messageId: "msg-emoji",
        text: "x".repeat(119) + "🧠tail",
        senderLabel: "User",
      },
      onClearReply,
    });
    expect(container.querySelector(".chat-reply-preview__text")?.textContent).toBe(
      `${"x".repeat(119)}...`,
    );
    container.querySelector<HTMLButtonElement>(".chat-reply-preview__dismiss")!.click();
    expect(onClearReply).toHaveBeenCalledTimes(1);
  });

  it.each(["keyCode229", "rerendered-live"])(
    "preserves the reply and draft for %s Escape before deliberate reply clearing and abort",
    (mode) => {
      const draft = "Keep this reply draft";
      const quote = "Keep this quoted message";
      const pane = createReplyPane(`reply-${mode}`, draft, quote);
      try {
        document.body.append(pane.container);
        pane.redraw();
        const textarea = getComposerTextarea(pane.container);
        textarea.focus();
        expect(document.activeElement).toBe(textarea);
        expect(textarea.value).toBe(draft);
        expect(pane.container.querySelector(".chat-reply-preview__text")?.textContent).toBe(quote);
        const updatesBeforeComposition = pane.onRequestUpdate.mock.calls.length;
        if (mode === "rerendered-live") {
          textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          expect(pane.onRequestUpdate).toHaveBeenCalledTimes(updatesBeforeComposition);
        }
        const visibleDraft = mode === "rerendered-live" ? `${draft} composing` : draft;
        if (mode === "rerendered-live") {
          textarea.value = visibleDraft;
          textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
          expect(pane.onRequestUpdate.mock.calls.length).toBeGreaterThan(updatesBeforeComposition);
          expect(pane.onDraftChange).not.toHaveBeenCalled();
        }
        const event = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
          keyCode: mode === "keyCode229" ? 229 : 0,
        });
        expect(event).toMatchObject({
          key: "Escape",
          bubbles: true,
          cancelable: true,
          isComposing: false,
          keyCode: mode === "keyCode229" ? 229 : 0,
          defaultPrevented: false,
        });
        textarea.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(false);
        expect(getComposerTextarea(pane.container)).toBe(textarea);
        expect(textarea.value).toBe(visibleDraft);
        expect(document.activeElement).toBe(textarea);
        expect(pane.host.draft).toBe(draft);
        expect(pane.host.replyTarget?.text).toBe(quote);
        expect(pane.container.querySelector(".chat-reply-preview__text")?.textContent).toBe(quote);
        expect(pane.onClearReply).not.toHaveBeenCalled();
        expect(pane.onSend).not.toHaveBeenCalled();
        expect(pane.onAbort).not.toHaveBeenCalled();

        if (mode === "rerendered-live") {
          textarea.blur();
          textarea.focus();
        }
        expect(pane.host.draft).toBe(visibleDraft);
        const clear = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        });
        textarea.dispatchEvent(clear);
        expect(clear.defaultPrevented).toBe(true);
        expect(pane.onClearReply).toHaveBeenCalledOnce();
        expect(pane.host.replyTarget).toBeNull();
        expect(pane.container.querySelector(".chat-reply-preview")).toBeNull();
        expect(pane.onAbort).not.toHaveBeenCalled();
        expect(getComposerTextarea(pane.container)).toBe(textarea);
        expect(textarea.value).toBe(visibleDraft);
        expect(document.activeElement).toBe(textarea);

        const abort = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        });
        textarea.dispatchEvent(abort);
        expect(abort.defaultPrevented).toBe(true);
        expect(pane.onAbort).toHaveBeenCalledOnce();
        expect(pane.onClearReply).toHaveBeenCalledOnce();
        expect(pane.onSend).not.toHaveBeenCalled();
        expect(pane.host.draft).toBe(visibleDraft);
        expect(getComposerTextarea(pane.container)).toBe(textarea);
        expect(textarea.value).toBe(visibleDraft);
        expect(document.activeElement).toBe(textarea);
      } finally {
        pane.dispose();
      }
    },
  );

  it("keeps a composing reply isolated from Escape in another pane", () => {
    const paneA = createReplyPane("reply-pane-a", "Draft A", "Quote A");
    const paneB = createReplyPane("reply-pane-b", "Draft B", "Quote B");
    try {
      document.body.append(paneA.container, paneB.container);
      paneA.redraw();
      paneB.redraw();
      const textareaA = getComposerTextarea(paneA.container);
      const textareaB = getComposerTextarea(paneB.container);
      textareaA.focus();
      textareaA.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const escapeB = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      textareaB.dispatchEvent(escapeB);

      expect(escapeB.defaultPrevented).toBe(true);
      expect(paneB.onClearReply).toHaveBeenCalledOnce();
      expect(paneB.host.replyTarget).toBeNull();
      expect(paneB.container.querySelector(".chat-reply-preview")).toBeNull();
      const escapeA = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      textareaA.dispatchEvent(escapeA);
      expect(escapeA.defaultPrevented).toBe(false);
      expect(paneA.onClearReply).not.toHaveBeenCalled();
      expect(paneA.host.replyTarget?.text).toBe("Quote A");
      expect(paneA.container.querySelector(".chat-reply-preview__text")?.textContent).toBe(
        "Quote A",
      );
      for (const [pane, textarea, draft] of [
        [paneA, textareaA, "Draft A"],
        [paneB, textareaB, "Draft B"],
      ] as const) {
        expect(getComposerTextarea(pane.container)).toBe(textarea);
        expect(textarea.value).toBe(draft);
        expect(pane.host.draft).toBe(draft);
        expect(pane.onSend).not.toHaveBeenCalled();
        expect(pane.onAbort).not.toHaveBeenCalled();
      }
      expect(document.activeElement).toBe(textareaA);
    } finally {
      paneA.dispose();
      paneB.dispose();
    }
  });

  it("adds Copy for an intersecting selection without changing the unselected menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const container = renderChatView({ onSetReply: vi.fn() });
    const section = container.querySelector<HTMLElement>(".chat");
    expect(section).not.toBeNull();

    const { bubble, group } = appendChatBubble(container, {
      messageId: "msg-1",
      text: "selectable text",
    });
    bubble.textContent = "selectable text";
    const otherBubble = document.createElement("div");
    otherBubble.className = "chat-bubble";
    otherBubble.dataset.messageText = "other text";
    otherBubble.textContent = "other text";
    group.append(otherBubble);

    const bubbleText = expectDefined(bubble.firstChild, "bubble text node");
    const otherText = expectDefined(otherBubble.firstChild, "other bubble text node");
    let selectedRange = document.createRange();
    selectedRange.setStart(bubbleText, 0);
    selectedRange.setEnd(otherText, otherText.textContent?.length ?? 0);
    const mockSelection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => selectedRange,
      toString: () => "selectable",
    } as unknown as Selection;
    vi.spyOn(window, "getSelection").mockReturnValue(mockSelection);

    const selectedEvent = dispatchContextMenu(bubble);

    expect(selectedEvent.defaultPrevented).toBe(true);
    expect(
      [...document.querySelectorAll(".chat-reply-context-menu button")].map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Copy", "Reply", "Copy as markdown"]);
    getContextMenuAction("Copy").click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("selectable"));

    selectedRange = document.createRange();
    selectedRange.selectNodeContents(otherBubble);
    const disjointEvent = dispatchContextMenu(bubble);

    expect(disjointEvent.defaultPrevented).toBe(true);
    expect(
      [...document.querySelectorAll(".chat-reply-context-menu button")].map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Reply", "Copy as markdown"]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

describe("chat transcript rendering cache", () => {
  it("shares assistant media context across history, streams, and continuations", () => {
    const mediaContext = {
      sessionKey: "agent:media:main",
      resourceBasePath: "/resources",
      assistantAttachmentAuthToken: "attachment-token",
      resolveArtifactDownload: vi.fn(),
      canvasPluginSurfaceUrl: "https://example.com/canvas",
      embedSandboxMode: "strict" as const,
      allowExternalEmbedUrls: true,
      onAssistantAttachmentLoaded: vi.fn(),
      onRequestUpdate: vi.fn(),
      onRequestOpenImage: vi.fn(() => 7),
      onOpenWorkspaceFile: vi.fn(),
    };
    const mediaProps = {
      ...mediaContext,
      currentAgentId: "current",
      fullMessageAgentId: "media",
      basePath: "/control",
      onOpenImage: vi.fn(),
    };
    const streamPart = {
      kind: "stream" as const,
      key: "stream:media:live",
      text: "MEDIA:https://example.com/voice.ogg",
      startedAt: 1,
      isStreaming: true,
    };
    const expected = { ...mediaContext, agentId: "current", runActive: true };

    vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([streamPart]);
    renderChatView({ ...mediaProps, canAbort: true, runActive: true });

    expect(vi.mocked(chatMessageStream.renderStreamGroup).mock.calls.at(-1)?.[1]).toMatchObject(
      expected,
    );
    expect(
      vi.mocked(chatMessageStream.renderStreamGroup).mock.calls.at(-1)?.[1]?.onOpenImage,
    ).toEqual(expect.any(Function));

    const reply = {
      kind: "group" as const,
      key: "group:assistant:media",
      role: "assistant",
      visibleContent: "text" as const,
      messages: [
        {
          key: "message:assistant:media",
          message: { role: "assistant", content: "Interim answer", timestamp: 1 },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    };
    vi.mocked(chatThread.buildCachedChatItems).mockReturnValue([
      reply,
      { kind: "reading-indicator", key: "reading:media", startedAt: 1 },
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);
    renderMessageGroupMock.mockClear();
    renderChatView({
      ...mediaProps,
      canAbort: true,
      runActive: true,
      messages: [{ role: "assistant", content: "Interim answer", timestamp: 1 }],
    });

    expect(renderMessageGroupMock.mock.calls.at(-1)?.[1]).toMatchObject(expected);
    expect(renderMessageGroupMock.mock.calls.at(-1)?.[1].activeContinuation?.options).toMatchObject(
      expected,
    );
  });
});
