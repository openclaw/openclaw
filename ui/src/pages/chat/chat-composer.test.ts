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

function expectClasses(element: Element | null | undefined, classes: string) {
  expect(new Set(element?.classList)).toEqual(new Set(classes.split(" ")));
}

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

  expect(textarea).not.toBeNull();
  textarea.value = "hello";
  textarea.dispatchEvent(new InputEvent("beforeinput", { bubbles: true }));
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
  textarea.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  expect(onTypingChange).toHaveBeenNthCalledWith(1, true, "hello", 5);
  expect(onTypingChange).toHaveBeenLastCalledWith(false);
});

const audioNode = () => ({ connect: vi.fn(), disconnect: vi.fn() });
class DictationAudioContext {
  readonly destination = {};
  readonly sampleRate = 8000;
  readonly close = vi.fn(async () => undefined);

  createMediaStreamSource = audioNode;
  createScriptProcessor = () => ({ ...audioNode(), onaudioprocess: null });
  createGain = () => ({ ...audioNode(), gain: { value: 1 } });
  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      ...audioNode(),
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0),
    };
  }
}

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

it("keeps composer, send, and queue class lists aligned with refreshed state", () => {
  const {
    container,
    query,
    props: initial,
  } = renderComposer({
    draft: "A draft",
    queue: [{ id: "a", text: "Queued message", createdAt: 1, sendState: "waiting-idle" }],
  });
  const assertClasses = (offline = false) => {
    expectClasses(
      query(".agent-chat__input"),
      "agent-chat__input agent-chat__input--chat agent-chat__input--mobile-toolbar" +
        (offline ? " agent-chat__input--offline" : ""),
    );
    expectClasses(
      query(".chat-send-btn--send"),
      "chat-send-btn chat-send-btn--send" + (offline ? " chat-send-btn--sending" : ""),
    );
    expectClasses(
      query(".chat-queue__item"),
      "chat-queue__item chat-queue__item--no-avatar" +
        (offline ? " chat-queue__item--reconnect" : ""),
    );
  };
  assertClasses();
  renderComposerInto(container, { ...initial, offline: true, sending: true });
  assertClasses(true);
  expectClasses(query(".chat-queue__badge"), "chat-queue__badge chat-queue__badge--reconnect");
  renderComposerInto(container, initial);
  assertClasses();
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
  button(container, t("chat.composer.startVoiceInput")).dispatchEvent(
    dictationPointer("pointerdown", 15),
  );
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

  expect(currentDraft).toBe("");
  expect(textarea.value).toBe("");
  expect(onDraftChange).toHaveBeenLastCalledWith("", undefined);
  expect(textarea.matches(":placeholder-shown")).toBe(true);
});

it.each([true, false])(
  "keeps the unsaved row edit visible and cancellable (source retained: %s)",
  (retained) => {
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
    const composer = query<HTMLTextAreaElement>(".agent-chat__composer-combobox textarea");

    composer?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    expect(onCancel).not.toHaveBeenCalled();
    expect(query<HTMLTextAreaElement>(".chat-queue__edit-input")?.value).toBe(
      "unsaved queued edit",
    );
    query<HTMLTextAreaElement>(".chat-queue__edit-input")?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(onCancel).toHaveBeenCalledOnce();
  },
);

it("lets queued rows own the offline outbox state", () => {
  const { container, query } = renderComposer({
    offline: true,
    draft: "Queue this message",
    queue: [
      { id: "a", text: "first", createdAt: 1, sendState: "waiting-idle" },
      { id: "b", text: "second", createdAt: 2, sendState: "waiting-idle" },
    ],
    onQueueRemove: vi.fn(),
  });

  expect(query(".agent-chat__input--offline")).not.toBeNull();
  expect(query(".agent-chat__composer-status-band")).toBeNull();
  expect(container.querySelectorAll(".chat-queue__badge--reconnect")).toHaveLength(2);
  expect(query<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
  expect(button(container, t("chat.runControls.sendMessage")).disabled).toBe(false);
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
  expect(query(".agent-chat__input")).toBeNull();
  expect(query("textarea")).toBeNull();
  expect(query("openclaw-chat-question-panel")).toBeNull();
  expect(query(".agent-chat__typing-indicator--outside")).toBeNull();
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
  const { container, query } = renderComposer({
    attachments: [{ id: "image-1", mimeType: "image/png", fileName: "proof.png" }],
    onSend,
    onToggleRealtimeTalk,
  });

  button(container, t("chat.runControls.sendMessage")).click();
  expect(onSend).toHaveBeenCalledOnce();
  expect(onToggleRealtimeTalk).not.toHaveBeenCalled();
  expect(query(`button[aria-label="${t("chat.composer.startVoiceInput")}"]`)).not.toBeNull();
});

it("keeps the dictation button stable through hold progress and latch", async () => {
  openMicrophoneMock.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
  vi.stubGlobal("AudioContext", DictationAudioContext);
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
  expectClasses(
    capturedButton,
    "chat-send-btn chat-send-btn--voice chat-send-btn--hold-enabled chat-send-btn--dictation-arming",
  );
  const holdingControl = capturedButton?.closest(".chat-talk-control");
  expectClasses(holdingControl, "chat-talk-control chat-talk-control--holding");
  expect(holdingControl?.querySelector(".chat-talk-input-picker")).not.toBeNull();
  expect(capturedButton!.hasPointerCapture(9)).toBe(true);
  await vi.advanceTimersByTimeAsync(500);

  const rerenderedButton = query<HTMLButtonElement>(
    ".chat-talk-control > openclaw-tooltip > button",
  );
  expect(request).toHaveBeenCalledWith("talk.session.create", expect.anything());
  expect(rerenderedButton).toBe(capturedButton);
  expectClasses(rerenderedButton, "chat-send-btn chat-send-btn--dictating");
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
  const microphone = button(container, t("chat.composer.startVoiceInput"));
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

  const microphone = button(container, t("chat.composer.startVoiceInput"));
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
  expect(query(".compaction-indicator--active")).toBeNull();
  expect(query(".chat-compaction")).toBeNull();
  expect(query(".compaction-indicator--fallback")?.textContent?.trim()).toBe(
    "Fallback active: deepinfra/moonshotai/Kimi-K2.5",
  );
  expect(query(".compaction-indicator--fallback")?.getAttribute("aria-label")).toBe(
    "Selected: fireworks/minimax-m2p5 • Active: deepinfra/moonshotai/Kimi-K2.5 • Attempts: fireworks/minimax-m2p5: rate limit",
  );
});
