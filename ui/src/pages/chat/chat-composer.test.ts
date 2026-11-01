/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerQuestionPrompt as questionPrompt,
  createComposerProps as props,
  findComposerButton as button,
  resetComposerFixture,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";
import type { ChatQuestionCard } from "./components/chat-question-card.ts";
import { MockDictationAudioContext } from "./talk/input.test-support.ts";
import * as realtimeTalkInput from "./talk/input.ts";

const discoverRealtimeTalkInputsMock = vi.fn();
const openMicrophoneMock = vi.fn();
function renderComposer(overrides: Parameters<typeof props>[0], attached = false) {
  const container = createComposerContainer();
  if (attached) {
    document.body.append(container);
  }
  const composerProps = props(overrides);
  renderComposerInto(container, composerProps);
  const query = container.querySelector.bind(container);
  return {
    container,
    props: composerProps,
    query,
    textarea: query<HTMLTextAreaElement>("textarea")!,
  };
}

const microphoneGuidance =
  "Waiting for microphone access. Bring this tab to the foreground and allow access if prompted.";
const voiceButton = (container: Element) => button(container, t("chat.composer.startVoiceInput"));

async function mountTalk(
  catalog: { transcription: { ready: boolean }; realtime?: { ready: boolean } },
  overrides: Parameters<typeof props>[0] = {},
  session = false,
) {
  vi.useFakeTimers();
  const request = vi.fn(async (method: string) => {
    if (method === "talk.config") {
      return { config: {} };
    }
    if (method === "talk.catalog") {
      return catalog;
    }
    if (session) {
      if (method === "talk.session.create") {
        return {
          sessionId: "dictation-1",
          transcriptionSessionId: "dictation-1",
          audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
        };
      }
      return { ok: true };
    }
    throw new Error(`unexpected request: ${method}`);
  });
  const view = renderComposer(
    {
      gatewayClient: {
        request,
        ...(session ? { addEventListener: vi.fn(() => () => undefined) } : {}),
      } as unknown as GatewayBrowserClient,
      onToggleRealtimeTalk: vi.fn(),
      ...overrides,
    },
    true,
  );
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("talk.catalog", { sessionKey: "main" }),
  );
  return { ...view, request };
}

it("shares the active caret on input and selection-only changes", () => {
  const draft = "First line\n😀 second line\nLast line  ";
  const onTypingChange = vi.fn();
  const { container, textarea } = renderComposer({ draft, onTypingChange });
  document.body.append(container);
  textarea.focus();
  textarea.setSelectionRange(14, 14);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
  expect(onTypingChange).toHaveBeenLastCalledWith(true, draft, 14);
  textarea.setSelectionRange(0, 5, "backward");
  textarea.dispatchEvent(new Event("select"));
  expect(onTypingChange).toHaveBeenLastCalledWith(true, draft, 0);
  textarea.setSelectionRange(draft.length, draft.length);
  textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "End", bubbles: true }));
  expect(onTypingChange).toHaveBeenLastCalledWith(true, draft, draft.length);
});

it.each([
  { name: "Control+Enter", key: { ctrlKey: true } },
  { name: "goal Enter", key: {}, goal: true },
  { name: "slash argument Enter", key: {}, command: true },
])("stops the submitted preview before $name dispatch", ({ key, goal, command }) => {
  let draft = command ? "/tools c" : "A shared draft";
  const onTypingChange = vi.fn();
  let typingAtSubmit: unknown;
  const submit = vi.fn(() => {
    typingAtSubmit = onTypingChange.mock.lastCall;
  });
  const { textarea } = renderComposer({
    draft,
    getDraft: () => draft,
    onDraftChange: (next) => {
      draft = next;
    },
    onTypingChange,
    onSend: submit,
    ...(goal
      ? {
          goalDraftMode: { action: "start" as const },
          onGoalSubmit: async () => {
            submit();
            return true;
          },
        }
      : {}),
  });
  textarea.dispatchEvent(new InputEvent("beforeinput", { bubbles: true }));
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
  expect(onTypingChange).toHaveBeenLastCalledWith(true, draft, textarea.selectionEnd);
  textarea.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", ...key, bubbles: true, cancelable: true }),
  );
  expect(submit).toHaveBeenCalledOnce();
  expect(typingAtSubmit).toEqual([false]);
  expect(onTypingChange).toHaveBeenLastCalledWith(false);
});

it("labels the send action as Suggest and emits ephemeral typing state", () => {
  const onTypingChange = vi.fn();
  const { query, textarea } = renderComposer({
    suggestionComposer: true,
    draft: "Suggest this",
    onTypingChange,
  });
  expect(query(".agent-chat__control-label")?.textContent).toContain("Suggest");
  expect(query<HTMLButtonElement>('button[aria-label="Add attachment"]')?.disabled).toBe(true);

  textarea.value = "hello";
  textarea.dispatchEvent(new InputEvent("beforeinput", { bubbles: true }));
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
  textarea.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  expect(onTypingChange).toHaveBeenNthCalledWith(1, true, "hello", 5);
  expect(onTypingChange).toHaveBeenLastCalledWith(false);
});

function dictationPointer(type: "pointerdown" | "pointerup", pointerId: number): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event as PointerEvent;
}

const mountComposer = (overrides: Parameters<typeof props>[0]) => renderComposer(overrides, true);

beforeEach(() => {
  onTestFinished(installChatComposerPickerDismissal(document));
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  // ESM imports remain live when the composer was cached by another test file.
  // Patch the shared dependencies instead of clearing isolate:false's registry.
  vi.spyOn(realtimeTalkInput, "discoverRealtimeTalkInputs").mockImplementation(
    discoverRealtimeTalkInputsMock,
  );
  vi.spyOn(realtimeTalkInput.RealtimeTalkInputOwner.prototype, "open").mockImplementation(
    openMicrophoneMock,
  );
});

afterEach(async () => {
  await resetComposerFixture(() => {
    discoverRealtimeTalkInputsMock.mockReset();
    openMicrophoneMock.mockReset();
  });
});

it("keeps offline outbox rows editable across connection and sending updates", async () => {
  const {
    container,
    query,
    props: initial,
  } = renderComposer({
    draft: "A draft",
    queue: [
      { id: "a", text: "first", createdAt: 1, sendState: "waiting-idle" },
      { id: "b", text: "second", createdAt: 2, sendState: "waiting-idle" },
    ],
  });
  const assertState = (offline: boolean, sending: boolean) =>
    expect([
      query(".agent-chat__input--offline") !== null,
      query(".chat-send-btn--sending") !== null,
      query(".chat-queue__item--reconnect") !== null,
    ]).toEqual([offline, sending, offline]);
  await waitForSolid(() => expect(query(".chat-queue__item")).not.toBeNull());
  assertState(false, false);
  renderComposerInto(container, { ...initial, offline: true, sending: true });
  assertState(true, true);
  await waitForSolid(() =>
    expect(container.querySelectorAll(".chat-queue__badge--reconnect")).toHaveLength(2),
  );
  renderComposerInto(container, { ...initial, offline: true });
  assertState(true, false);
  expect(query(".agent-chat__composer-status-band")).toBeNull();
  expect(query<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
  expect(button(container, t("chat.runControls.sendMessage")).disabled).toBe(false);
  renderComposerInto(container, initial);
  assertState(false, false);
});

it("shows actionable connecting guidance in a visible status region", () => {
  const { container, query } = renderComposer({
    realtimeTalkActive: true,
    realtimeTalkStatus: "connecting",
    realtimeTalkDetail: microphoneGuidance,
    onToggleRealtimeTalk: vi.fn(),
  });
  const pending = query('.agent-chat__talk-status[role="status"]');
  expect(pending?.textContent).toContain(microphoneGuidance);
  expect(pending?.closest(".sr-only")).toBeNull();
  expect(query('[role="alert"]')).toBeNull();
  expect(button(container, t("chat.composer.stopVoiceInput")).disabled).toBe(false);
});

it("shows the same microphone guidance while dictation waits for access", async () => {
  vi.useFakeTimers();
  openMicrophoneMock.mockReturnValue(new Promise(() => {}));
  const dismissRecovery = vi.fn();
  const { container, query } = mountComposer({
    gatewayClient: {
      request: vi.fn(async () => ({ transcription: { ready: true } })),
    } as unknown as GatewayBrowserClient,
    onToggleRealtimeTalk: vi.fn(),
    realtimeTalkStatus: "error",
    realtimeTalkDetail: "The selected microphone is unavailable",
    onUseSystemDefaultMicrophone: vi.fn(),
    onDismissRealtimeTalkError: dismissRecovery,
  });
  await vi.advanceTimersByTimeAsync(0);
  voiceButton(container).dispatchEvent(dictationPointer("pointerdown", 15));
  expect(dismissRecovery).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(800);
  expect(query('.agent-chat__talk-status[role="status"]')?.textContent).toContain(
    microphoneGuidance,
  );
  expect(query(".agent-chat__dictation-phase")).toBeNull();
});

it("clears a live whitespace draft when the last rendered draft was already empty", () => {
  let currentDraft = "  \n  ";
  const onDraftChange = vi.fn((next: string) => {
    currentDraft = next;
  });
  const { textarea } = renderComposer({
    draft: "",
    getDraft: () => currentDraft,
    onDraftChange,
  });
  textarea.value = currentDraft;
  textarea.dispatchEvent(new FocusEvent("blur", { bubbles: true }));

  expect([currentDraft, textarea.value]).toEqual(["", ""]);
  expect(onDraftChange).toHaveBeenLastCalledWith("", undefined);
  expect(textarea.matches(":placeholder-shown")).toBe(true);
});

it.each([true, false])(
  "keeps the unsaved row edit visible and cancellable (source retained: %s)",
  async (retained) => {
    const onCancel = vi.fn();
    const source = { id: "queued", text: "original queued text", createdAt: 1 };
    const { query } = renderComposer({
      draft: "select this composer text",
      queue: retained ? [source] : [],
      queuedEdit: {
        editingId: "queued",
        editingText: "unsaved queued edit",
        source,
        onCancel,
      },
    });
    const editor = () => query<HTMLTextAreaElement>(".chat-queue__edit-input");
    await waitForSolid(() => expect(editor()?.value).toBe("unsaved queued edit"));
    query(".agent-chat__composer-combobox textarea")?.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true }),
    );
    expect(onCancel).not.toHaveBeenCalled();
    expect(editor()?.value).toBe("unsaved queued edit");
    editor()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onCancel).toHaveBeenCalledOnce();
  },
);

it("releases layout observation when a banner replaces the input", async () => {
  vi.useFakeTimers();
  const { container, props: initial } = renderComposer({}, true);
  const input = container.querySelector<HTMLElement>(".agent-chat__input")!;
  let top = 100;
  vi.spyOn(input, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, top, 400, 48));
  window.dispatchEvent(new Event("resize"));
  await vi.advanceTimersByTimeAsync(20);
  expect(input.style.getPropertyValue("--chat-composer-popover-max-height")).toBe("72px");

  renderComposerInto(container, {
    ...initial,
    disabledBanner: { kind: "composer-replacement", text: "This session is archived." },
  });
  expect(container.querySelector(".agent-chat__input")).toBeNull();
  top = 200;
  window.dispatchEvent(new Event("resize"));
  await vi.advanceTimersByTimeAsync(20);
  expect(input.style.getPropertyValue("--chat-composer-popover-max-height")).toBe("72px");

  renderComposerInto(container, initial);
  const replacement = container.querySelector<HTMLElement>(".agent-chat__input")!;
  expect(replacement).not.toBe(input);
  vi.spyOn(replacement, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 300, 400, 48));
  window.dispatchEvent(new Event("resize"));
  await vi.advanceTimersByTimeAsync(20);
  expect(replacement.style.getPropertyValue("--chat-composer-popover-max-height")).toBe("272px");
  expect(input.style.getPropertyValue("--chat-composer-popover-max-height")).toBe("72px");
});

it("replaces the composer with the archived-session notice", () => {
  const onAction = vi.fn();
  const onAbort = vi.fn();
  const { query } = renderComposer({
    canSend: false,
    canAbort: true,
    onAbort,
    gatewayQuestionPrompts: [{ ...questionPrompt("pending", "Continue?"), sessionKey: "main" }],
    messages: [
      {
        role: "assistant",
        openclawAsyncDelivery: {
          itemId: "audience",
          questions: [{ title: "Which audience?" }],
        },
      },
    ],
    onAsyncQuestionSubmit: vi.fn(async () => true),
    disabledBanner: {
      kind: "composer-replacement",
      text: "This session is archived. Unarchive it to continue the conversation.",
      actionLabel: "Unarchive",
      onAction,
    },
  });

  const banner = query(".agent-chat__disabled-banner");
  expect(banner?.textContent).toContain("This session is archived.");
  expect(
    query(
      ".agent-chat__input, textarea, openclaw-chat-question-panel, .agent-chat__typing-indicator--outside",
    ),
  ).toBeNull();
  banner?.querySelector<HTMLButtonElement>("button")?.click();
  expect(onAction).toHaveBeenCalledOnce();
  const stop = query<HTMLButtonElement>(`[aria-label="${t("chat.runControls.stopGenerating")}"]`);
  expect(stop).not.toBeNull();
  stop?.click();
  expect(onAbort).toHaveBeenCalledOnce();
});

it.each([
  ["read-only", "This session is read-only.", false],
  ["placement", "Preparing workspace…", true],
] as const)("shows the %s reason beside a disabled draft", (_name, reason, busy) => {
  const { query } = renderComposer({
    canSend: false,
    disabledReason: reason,
    draft: "Keep this draft",
    ...(busy
      ? { disabledReasonTone: "info" as const, disabledReasonBusy: true }
      : { offline: true }),
  });
  expect(query("textarea")).toMatchObject({ disabled: true });
  if (busy) {
    expect(query(".agent-chat__input")?.getAttribute("aria-busy")).toBe("true");
    const status = query('.agent-chat__composer-status[data-tone="info"]');
    expect(status?.textContent).toContain(reason);
    expect(status?.querySelector(".btn__spinner")).not.toBeNull();
  } else {
    expect(query(".agent-chat__composer-status-band")?.textContent).toContain(reason);
    expect(query(".agent-chat__disabled-banner")).toBeNull();
    expect(query(".agent-chat__input")).not.toBeNull();
  }
});

it("keeps send and dictation distinct for attachment-only drafts", () => {
  const onSend = vi.fn();
  const onToggleRealtimeTalk = vi.fn();
  const { container } = renderComposer({
    attachments: [{ id: "image-1", mimeType: "image/png", fileName: "proof.png" }],
    onSend,
    onToggleRealtimeTalk,
  });

  button(container, t("chat.runControls.sendMessage")).click();
  expect(onSend).toHaveBeenCalledOnce();
  expect(onToggleRealtimeTalk).not.toHaveBeenCalled();
  expect(voiceButton(container)).not.toBeNull();
});

it("keeps the dictation button stable through hold progress and latch", async () => {
  openMicrophoneMock.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
  vi.stubGlobal("AudioContext", MockDictationAudioContext);
  const { query, request } = await mountTalk(
    { transcription: { ready: true } },
    { draft: "Keep this text" },
    true,
  );
  await vi.waitFor(() => expect(query('[data-chat-talk-capability="dictation"]')).toBeNull());

  const capturedButton = query<HTMLButtonElement>(".chat-talk-control > openclaw-tooltip > button");
  expect(capturedButton).not.toBeNull();
  const captures = new Set<number>();
  Object.defineProperties(capturedButton!, {
    setPointerCapture: { value: (pointerId: number) => captures.add(pointerId) },
    hasPointerCapture: { value: (pointerId: number) => captures.has(pointerId) },
    releasePointerCapture: { value: (pointerId: number) => captures.delete(pointerId) },
  });

  capturedButton!.dispatchEvent(dictationPointer("pointerdown", 9));
  expect(capturedButton!.hasPointerCapture(9)).toBe(true);
  await vi.advanceTimersByTimeAsync(300);
  expect(capturedButton?.matches(".chat-send-btn--dictation-arming")).toBe(true);
  const holdingControl = capturedButton?.closest(".chat-talk-control");
  expect(holdingControl?.matches(".chat-talk-control--holding")).toBe(true);
  expect(holdingControl?.querySelector(".chat-talk-input-picker")).not.toBeNull();
  expect(capturedButton!.hasPointerCapture(9)).toBe(true);
  await vi.advanceTimersByTimeAsync(500);

  const rerenderedButton = query<HTMLButtonElement>(
    ".chat-talk-control > openclaw-tooltip > button",
  );
  expect(request).toHaveBeenCalledWith("talk.session.create", expect.anything());
  expect(rerenderedButton).toBe(capturedButton);
  expect(rerenderedButton?.matches(".chat-send-btn--dictating")).toBe(true);
  expect(query(".agent-chat__dictation-phase--listening")?.textContent?.trim()).toBe(
    t("chat.composer.dictationListening"),
  );
  expect(rerenderedButton?.hasPointerCapture(9)).toBe(false);
});

it("keeps the microphone picker open without leaking an unavailable hold into Talk", async () => {
  discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
  const onToggleRealtimeTalk = vi.fn();
  const { container, query } = await mountTalk(
    { realtime: { ready: true }, transcription: { ready: false } },
    { onToggleRealtimeTalk },
  );
  const microphone = voiceButton(container);
  microphone.dispatchEvent(dictationPointer("pointerdown", 10));
  await vi.advanceTimersByTimeAsync(801);
  const dropdown = query(".chat-talk-input-picker");
  expect(dropdown?.hasAttribute("open")).toBe(true);
  await vi.waitFor(() =>
    expect(
      query('[data-chat-talk-capability="dictation"][data-status="unavailable"]'),
    ).not.toBeNull(),
  );

  document.dispatchEvent(dictationPointer("pointerup", 10));
  microphone.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(dropdown?.hasAttribute("open")).toBe(true);
  expect(onToggleRealtimeTalk).not.toHaveBeenCalled();

  microphone.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(onToggleRealtimeTalk).toHaveBeenCalledOnce();
});

it("shows an actionable error status and returns the microphone to idle on startup failure", async () => {
  openMicrophoneMock.mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
  const { container, query } = await mountTalk({
    realtime: { ready: true },
    transcription: { ready: true },
  });

  const microphone = voiceButton(container);
  microphone.dispatchEvent(dictationPointer("pointerdown", 12));
  await vi.advanceTimersByTimeAsync(800);
  await vi.waitFor(() =>
    expect(query('.agent-chat__composer-status[data-tone="danger"]')).not.toBeNull(),
  );

  const status = query('.agent-chat__composer-status[data-tone="danger"]');
  expect(status?.getAttribute("role")).toBeNull();
  expect(status?.querySelector('[role="alert"]')?.textContent).toContain(
    t("chat.composer.microphonePermissionBlocked"),
  );
  expect(status?.textContent).toContain(t("chat.composer.dictationStartRecovery"));
  expect(query(".chat-send-btn--dictating")).toBeNull();
  expect(query(".chat-send-btn--voice")).not.toBeNull();
});

it("keeps every concurrent gateway question reachable", async () => {
  const { query } = renderComposer({
    sessionKey: "queue-test",
    gatewayQuestionPrompts: [
      questionPrompt("question-1", "First prompt"),
      questionPrompt("question-2", "Second prompt"),
    ],
  });

  const panel = query<ChatQuestionCard>("openclaw-chat-question-card")!;
  expect(panel.props!.model.questions[0]?.question).toBe("First prompt");
  expect(panel.props!.model.requestPosition).toEqual({ current: 1, total: 2 });

  panel.props!.onNextRequest?.();
  await waitForSolid(() => {
    const nextPanel = query<ChatQuestionCard>("openclaw-chat-question-card")!;
    expect(nextPanel.props!.model.questions[0]?.question).toBe("Second prompt");
    expect(nextPanel.props!.model.requestPosition).toEqual({ current: 2, total: 2 });
  });
});

it("keeps fallback status in the composer without a compaction overlay", () => {
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  const { query } = renderComposer({
    fallbackStatus: {
      selected: "fireworks/minimax-m2p5",
      active: "deepinfra/moonshotai/Kimi-K2.5",
      attempts: ["fireworks/minimax-m2p5: rate limit"],
      occurredAt: 900,
    },
  });
  expect(query(".compaction-indicator--active, .chat-compaction")).toBeNull();
  // Localized text and accessible details belong to chat-composer-status.test.tsx.
  expect(query(".compaction-indicator--fallback")).not.toBeNull();
});
