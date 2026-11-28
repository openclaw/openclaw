/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { createComposerDraftSource } from "../../lib/chat/composer-draft-changes.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  findComposerButton as button,
  findPrimaryButton as primaryButton,
  renderComposerFixture,
  resetComposerFixture,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import type { ChatComposerProps } from "./components/chat-composer-types.ts";
import { placeComposerDictation } from "./composer-dictation-session.ts";
import { audioFixture, MockDictationAudioContext } from "./talk/input.test-support.ts";

afterEach(() => resetComposerFixture());

function renderComposer(overrides: Partial<ChatComposerProps> = {}) {
  const view = renderComposerFixture(overrides);
  return { ...view, onSend: view.props.onSend, onDraftChange: view.props.onDraftChange };
}

type QueuedMessage = NonNullable<ChatComposerProps["queue"]>[number];
function queued(id: string, overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return { id, text: id, createdAt: 1, ...overrides };
}

function textarea(container: Element) {
  return container.querySelector<HTMLTextAreaElement>("textarea")!;
}

function query(container: Element, selector: string) {
  return container.querySelector<HTMLButtonElement>(selector);
}

function activeRun(overrides: Partial<ChatComposerProps> = {}): Partial<ChatComposerProps> {
  return { canAbort: true, onAbort: vi.fn(), ...overrides };
}

function pressComposerKey(container: Element, key: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    ...modifiers,
  });
  textarea(container).dispatchEvent(event);
  return event;
}

function pressComposerEnter(container: Element, modifiers: KeyboardEventInit = {}) {
  return pressComposerKey(container, "Enter", modifiers);
}

async function renderQueue(queue: QueuedMessage[], overrides: Partial<ChatComposerProps> = {}) {
  const view = renderComposer({ queue, ...overrides });
  await waitForSolid(() => expect(query(view.container, ".chat-queue__item")).not.toBeNull());
  return (part: string) => query(view.container, `.chat-queue__${part}`);
}

describe("renderChatComposer controls", () => {
  it.each(["Win32", "Linux x86_64", "MacIntel"])(
    "uses compact non-Mac alternate-send hints on %s",
    (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const { container } = renderComposer({
        ...activeRun(),
        draft: "Follow up",
        followUpMode: "steer",
        sendShortcut: "enter",
      });
      const hints = Array.from(container.querySelectorAll("kbd"), (key) => key.textContent);
      expect(hints).toContain(platform === "MacIntel" ? "⌘/Ctrl+Enter" : "CtrlEnter");
    },
  );

  it.each([
    { name: "without send permission", draft: "local draft", canCompose: true, canSend: false },
    { name: "offline text", draft: "queue this", connected: false, allowed: true },
    { name: "offline Stop", draft: "/stop", connected: false, allowed: true },
    { name: "normalized offline Stop", draft: " /STOP ", connected: false, allowed: true },
    { name: "offline status", draft: "/status", connected: false },
    { name: "offline approval", draft: "/approve", connected: false },
    { name: "offline Stop arguments", draft: "/stop later", connected: false },
    {
      name: "after history failed",
      draft: "/compact",
      submitDisabledReason: "History failed. Retry to load the conversation.",
      submitPending: false,
    },
  ])("gates submission $name", ({ name: _name, allowed = false, ...overrides }) => {
    const { container, onSend } = renderComposer(overrides);
    const send = primaryButton(container);
    expect(send.disabled).toBe(!allowed);
    if (overrides.submitDisabledReason) {
      expect(send.getAttribute("aria-label")).toBe(overrides.submitDisabledReason);
      expect(send.getAttribute("aria-busy")).toBe("false");
      expect(send.querySelector(".btn__spinner")).toBeNull();
    } else {
      expect(textarea(container).disabled).toBe(false);
    }
    send.click();
    expect(pressComposerEnter(container).defaultPrevented).toBe(allowed);
    expect(onSend).toHaveBeenCalledTimes(allowed ? 2 : 0);
    expect(textarea(container).value).toBe(overrides.draft);
  });

  it("sends an Enter made while the session loads once the composer is ready", async () => {
    const loading = {
      draft: "Ship it",
      canCompose: true,
      canSend: false,
      submitPending: true,
      submitDisabledReason: "Loading conversation…",
    };
    const { container, props, onSend } = renderComposer(loading);
    expect(pressComposerEnter(container).defaultPrevented).toBe(true);
    await waitForSolid(() =>
      expect(query(container, ".agent-chat__input--submit-queued")).not.toBeNull(),
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea(container).value).toBe("Ship it");

    renderComposerInto(container, {
      ...props,
      canSend: true,
      submitPending: false,
      submitDisabledReason: null,
    });
    await waitForSolid(() => expect(onSend).toHaveBeenCalledOnce());
    expect(query(container, ".agent-chat__input--submit-queued")).toBeNull();
  });

  it("withdraws a queued Enter when the draft changes before the session is ready", async () => {
    const { container, props, onSend } = renderComposer({
      draft: "First thought",
      canCompose: true,
      canSend: false,
      submitPending: true,
      submitDisabledReason: "Loading conversation…",
    });
    pressComposerEnter(container);
    renderComposerInto(container, { ...props, draft: "Second thought" });
    renderComposerInto(container, {
      ...props,
      draft: "Second thought",
      canSend: true,
      submitPending: false,
      submitDisabledReason: null,
    });
    await waitForSolid(() =>
      expect(query(container, ".agent-chat__input--submit-queued")).toBeNull(),
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps desktop and mobile Stop available with a pending attachment", () => {
    const onAbort = vi.fn();
    const onTypingChange = vi.fn();
    const { container, props, onSend, onDraftChange } = renderComposer({
      canAbort: true,
      canCompose: true,
      draft: "Keep this draft",
      onAbort,
      onTypingChange,
      pendingAttachmentReads: 1,
    });
    const stop = primaryButton(container);

    expect(stop.disabled).toBe(false);
    expect(stop.getAttribute("aria-label")).toBe(t("chat.runControls.stop"));
    expect(query(container, ".chat-mobile-primary-action > openclaw-tooltip > button")).toBe(stop);
    expect(container.querySelectorAll(".chat-send-btn--stop")).toHaveLength(1);
    stop.click();
    expect(onAbort).toHaveBeenCalledOnce();
    for (const callback of [onSend, onDraftChange, onTypingChange]) {
      expect(callback).not.toHaveBeenCalled();
    }
    expect(textarea(container).value).toBe(props.draft);
  });

  function renderDictatingComposer({
    submitDisabledReason,
    finalizing = false,
    correctionCapture = false,
  }: {
    submitDisabledReason?: string;
    finalizing?: boolean;
    correctionCapture?: boolean;
  } = {}) {
    let draft = "Typed beginning";
    const onSend = vi.fn();
    const { container, props } = renderComposer({
      draft,
      getDraft: () => draft,
      onDraftChange: (value) => {
        draft = value;
      },
      onSend: (_mode, action) => onSend(draft, action),
      onToggleRealtimeTalk: vi.fn(),
      submitDisabledReason,
    });
    const dictation = getChatComposerState(props.paneId).dictation;
    if (!dictation) {
      throw new Error("expected the composer dictation controller");
    }
    const active = vi.spyOn(dictation, "active", "get").mockReturnValue(true);
    const locked = vi.spyOn(dictation, "locksComposer", "get").mockReturnValue(true);
    const correctionCommitRequired = vi
      .spyOn(dictation, "correctionCommitRequired", "get")
      .mockReturnValue(correctionCapture);
    vi.spyOn(dictation, "finalizing", "get").mockReturnValue(finalizing);
    const finishActive = vi.spyOn(dictation, "finishActive").mockResolvedValue(true);
    // Commits arrive only after the capture module, which places transcripts, has loaded.
    vi.spyOn(dictation, "placeTranscript").mockImplementation(placeComposerDictation);
    const update = vi.spyOn(dictation, "update");
    renderComposerInto(container, props);
    const commit = update.mock.lastCall?.[0].onCommit;
    if (!commit) {
      throw new Error("expected the composer transcript callback");
    }
    return { container, active, locked, correctionCommitRequired, finishActive, onSend, commit };
  }

  it("finishes locked dictation before submitting the complete draft with history held", async () => {
    const { container, active, locked, finishActive, onSend, commit } = renderDictatingComposer({
      submitDisabledReason: "Loading conversation…",
    });
    const finalTranscript = createDeferred<string>();
    finishActive.mockImplementation(async () => {
      const transcript = await finalTranscript.promise;
      active.mockReturnValue(false);
      locked.mockReturnValue(false);
      commit(transcript);
      return true;
    });
    const input = textarea(container);
    input.setSelectionRange(input.value.length, input.value.length);
    pressComposerEnter(container);
    expect(onSend).not.toHaveBeenCalled();

    const send = primaryButton(container);
    expect(send.getAttribute("aria-label")).toBe("Send");
    expect(send.disabled).toBe(false);
    const action = new MouseEvent("click", { bubbles: true, cancelable: true });
    send.dispatchEvent(action);

    expect(finishActive).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    finalTranscript.resolve("dictated ending");
    await vi.waitFor(() =>
      expect(onSend).toHaveBeenCalledExactlyOnceWith("Typed beginning dictated ending", action),
    );
  });

  it.each([false, true])(
    "keeps active Stop and Send mounted while dictation finalizes (correction=%s)",
    (correctionCapture) => {
      const { container } = renderDictatingComposer({ finalizing: true, correctionCapture });

      for (const kind of ["dictating", "dictation-commit"]) {
        const action = query(container, `.chat-send-btn--${kind}`);
        expect(action?.disabled).toBe(false);
        expect(action?.getAttribute("aria-disabled")).toBe("true");
      }
    },
  );

  it.each([false, true])(
    "preserves Off empty Send and blocks uncommitted correction captures (correction=%s)",
    async (correctionCapture) => {
      const { container, active, locked, correctionCommitRequired, finishActive, onSend } =
        renderDictatingComposer({ correctionCapture });
      const finish = createDeferred<boolean>();
      finishActive.mockReturnValue(finish.promise);
      primaryButton(container).click();
      active.mockReturnValue(false);
      locked.mockReturnValue(false);
      correctionCommitRequired.mockReturnValue(false);
      finish.resolve(false);
      await finish.promise;

      expect(finishActive).toHaveBeenCalledOnce();
      expect(textarea(container).value).toBe("Typed beginning");
      expect(onSend).toHaveBeenCalledTimes(correctionCapture ? 0 : 1);
    },
  );

  it.each(["finalization", "review"])(
    "holds Send and both microphone controls while an inactive recording awaits %s",
    async (phase) => {
      const { container, props, onSend } = renderComposer({
        draft: "Typed beginning",
        onToggleRealtimeTalk: vi.fn(),
      });
      const dictation = getChatComposerState(props.paneId).dictation;
      if (!dictation) {
        throw new Error("expected the composer dictation owner");
      }
      const original = "I work Tuesday, no Wednesday shifts are available";
      const pending = vi.spyOn(dictation, "correctionCommitRequired", "get").mockReturnValue(true);
      const review = vi.spyOn(dictation, "correctionReview", "get").mockReturnValue(
        phase === "review"
          ? {
              original,

              canKeepOriginal: true,
              invalidated: false,
            }
          : null,
      );
      const start = vi.spyOn(dictation, "startDirect").mockReturnValue(false);
      const hold = vi.spyOn(dictation, "handlePointerDown").mockReturnValue(false);
      renderComposerInto(container, props);
      if (phase === "review") {
        await waitForSolid(() =>
          expect(container.querySelector(".composer-correction-review")).not.toBeNull(),
        );
      }
      const microphones = container.querySelectorAll<HTMLButtonElement>(".chat-send-btn--voice");
      expect(microphones).toHaveLength(2);
      const reason = t(
        phase === "review"
          ? "chat.corrections.reviewBeforeRecording"
          : "chat.corrections.waitBeforeRecording",
      );
      for (const microphone of microphones) {
        expect(microphone.disabled).toBe(true);
        expect(microphone.getAttribute("aria-disabled")).toBe("true");
        expect(microphone.getAttribute("aria-label")).toBe(reason);
        expect(microphone.closest("openclaw-tooltip")).toHaveProperty("content", reason);
        microphone.click();
        // Late queued events also recheck the owner before any start-selection callback.
        microphone.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        microphone.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      }
      expect(start).not.toHaveBeenCalled();
      expect(hold).not.toHaveBeenCalled();
      expect(props.onToggleRealtimeTalk).not.toHaveBeenCalled();
      const send = primaryButton(container);
      expect(send.disabled).toBe(true);
      if (phase === "review") {
        expect(send.getAttribute("aria-label")).toBe(t("chat.corrections.reviewBeforeSend"));
      }
      send.click();
      pressComposerEnter(container);
      expect(textarea(container).value).toBe("Typed beginning");
      expect(onSend).not.toHaveBeenCalled();
      pending.mockReturnValue(false);
      review.mockReturnValue(null);
      renderComposerInto(container, props);
      const ready = container.querySelectorAll<HTMLButtonElement>(".chat-send-btn--voice");
      expect(ready).toHaveLength(2);
      for (const microphone of ready) {
        expect(microphone.disabled).toBe(false);
      }
    },
  );

  it("keeps dictation available while Talk is held during an active turn", () => {
    const { container } = renderComposer({
      sending: true,
      onToggleRealtimeTalk: vi.fn(),
    });

    const mobileDictation = query(container, ".chat-mobile-dictation-action .chat-send-btn--voice");
    expect(mobileDictation?.disabled).toBe(false);
    expect(button(container, t("chat.composer.startVoiceInput")).disabled).toBe(false);
    expect(query(container, ".chat-mobile-talk-action .chat-send-btn")?.disabled).toBe(true);
  });

  it.each([true, false])(
    "holds Talk during initial history while preserving draft input (hold-to-record=%s)",
    async (composerHoldToRecord) => {
      const request = vi.fn().mockResolvedValue({
        realtime: { ready: true },
        transcription: { ready: true },
      });
      const onToggleRealtimeTalk = vi.fn();
      const { container } = renderComposer({
        composerHoldToRecord,
        gatewayClient: createTestGatewayClient(request),
        onToggleRealtimeTalk,
        submitDisabledReason: t("chat.thread.loading"),
      });
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("talk.catalog", { sessionKey: "main" }),
      );
      const microphone = button(container, t("chat.composer.startVoiceInput"));
      const talk = button(container, t("chat.composer.realtimeTalkCapability"));
      microphone.click();
      talk.click();
      expect(onToggleRealtimeTalk).not.toHaveBeenCalled();
      expect(talk.disabled).toBe(true);
      expect(microphone.disabled).toBe(!composerHoldToRecord);
      expect(textarea(container).disabled).toBe(false);
    },
  );

  it("disables live voice offline", () => {
    const view = renderComposer({ connected: false, onToggleRealtimeTalk: vi.fn() });
    expect(button(view.container, t("chat.composer.startVoiceInput")).disabled).toBe(true);
  });

  it("offers Steer only for eligible queued messages during an active run", async () => {
    const onQueueSteer = vi.fn();
    const { container } = renderComposer({
      ...activeRun(),
      onQueueSteer,
      queue: [
        queued("queued-1"),
        queued("pending-1", { createdAt: 2, pendingRunId: "run-1" }),
        queued("local-1", { text: "/status", createdAt: 3, localCommandName: "status" }),
        queued("waiting-idle-1", { createdAt: 4, sendState: "waiting-idle" }),
      ],
    });
    await vi.dynamicImportSettled();
    const steer = await waitForSolid(() => {
      const buttons = [...container.querySelectorAll<HTMLButtonElement>(".chat-queue__action")];
      expect(buttons).toHaveLength(2);
      return buttons;
    });
    steer[0]?.click();
    steer[1]?.click();
    expect(onQueueSteer.mock.calls).toEqual([["queued-1"], ["waiting-idle-1"]]);
  });

  it.each([false, true])("steers empty Enter only on desktop (mobile=%s)", (mobile) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(mobile ? "Android" : "Windows");
    const onQueueSteer = vi.fn();
    const { container, onSend } = renderComposer({
      ...activeRun(),
      onQueueSteer,
      queue: [
        queued("later", { createdAt: 30, sessionKey: "main" }),
        // Pending rows may omit sessionKey; the Enter path matches the queue
        // chip's visible surface, so this row stays eligible.
        queued("pending-unscoped", { createdAt: 10 }),
        queued("failed", { createdAt: 2, sessionKey: "main", sendState: "failed" }),
      ],
    });
    const event = pressComposerEnter(container);

    expect(event.defaultPrevented).toBe(!mobile);
    expect(onQueueSteer.mock.calls).toEqual(mobile ? [] : [["pending-unscoped"]]);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not steer from Enter while admission is held", async () => {
    const onQueueSteer = vi.fn();
    const { container } = renderComposer({
      ...activeRun(),
      connected: true,
      submitDisabledReason: "Loading history",
      onQueueSteer,
      queue: [queued("queued", { sessionKey: "main" })],
    });

    pressComposerEnter(container);
    expect(onQueueSteer).not.toHaveBeenCalled();
    await vi.dynamicImportSettled();
    await waitForSolid(() => expect(container.querySelector(".chat-queue__item")).not.toBeNull());
    expect(container.querySelector(".chat-queue__action")).toBeNull();
  });

  it.each([
    ["steer", "queue", "Queue this next", undefined, undefined],
    [
      "collect",
      "steer",
      "",
      () => [{ id: "image-1", mimeType: "image/png", fileName: "proof.png" }],
      undefined,
    ],
    ["followup", "steer", "", undefined, "Steer the live textarea value"],
  ] as const)(
    "submits %s as %s with modified Enter",
    (followUpMode, alternateMode, draft, getAttachments, liveDraft) => {
      const onTypingChange = vi.fn();
      const { container, onSend } = renderComposer({
        ...activeRun(),
        draft,
        followUpMode,
        getAttachments,
        sendShortcut: "enter",
        onTypingChange,
      });
      if (liveDraft !== undefined) {
        textarea(container).value = liveDraft;
      }

      const action = pressComposerEnter(container, { ctrlKey: true });
      expect(onSend).toHaveBeenCalledOnce();
      expect(onSend).toHaveBeenCalledWith(alternateMode, action);
      expect(onTypingChange).toHaveBeenLastCalledWith(false);

      const held = pressComposerEnter(container, { ctrlKey: true, repeat: true });
      expect(held.defaultPrevented).toBe(true);
      expect(onSend).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["modifier-enter", "steer", false],
    ["enter", "queue", true],
  ] as const)(
    "keeps ordinary send semantics for shortcut=%s mode=%s alt=%s",
    (sendShortcut, followUpMode, altKey) => {
      const { container, onSend } = renderComposer({
        ...activeRun(),
        draft: "Keep the ordinary send path",
        followUpMode,
        sendShortcut,
      });

      const action = pressComposerEnter(container, { altKey, ctrlKey: true });

      expect(onSend).toHaveBeenCalledExactlyOnceWith(undefined, action);
    },
  );

  it("keeps newline keys, including repeats, for enter", () => {
    const { container, onSend } = renderComposer({
      ...activeRun(),
      draft: "Keep editing",
      followUpMode: "queue",
      sendShortcut: "enter",
    });

    for (const repeat of [false, true]) {
      const event = pressComposerEnter(container, {
        ctrlKey: true,
        shiftKey: true,
        repeat,
      });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not advertise an unavailable alternate action", () => {
    const unavailable: [Partial<ChatComposerProps>, string][] = [
      [activeRun({ sendShortcut: "modifier-enter" }), t("chat.runControls.queue")],
      [{}, t("chat.runControls.send")],
      [activeRun({ followUpMode: "interrupt" }), t("chat.runControls.send")],
      [activeRun({ connected: false }), t("chat.runControls.queue")],
      [
        activeRun({ followUpMode: "steer", suggestionComposer: true, sendShortcut: undefined }),
        t("chat.sessionSuggestions.suggest"),
      ],
    ];
    for (const [overrides, expected] of unavailable) {
      const view = renderComposer({
        draft: "Follow up",
        followUpMode: "queue",
        sendShortcut: "enter",
        ...overrides,
      });
      const tooltip = primaryButton(view.container).closest<HTMLElement & { content?: string }>(
        "openclaw-tooltip",
      );
      const text = tooltip?.querySelector('[slot="content"]')?.textContent ?? tooltip?.content;
      expect(text).toContain(expected);
      expect(text).not.toContain(" · ");
    }
  });

  it.each([
    { mode: "explicit", withSlashMenu: false },
    { mode: "explicit", withSlashMenu: true },
    { mode: "off", withSlashMenu: false },
  ] as const)(
    "preserves mounted dictation Escape ownership (mode=$mode, slash menu=$withSlashMenu)",
    async ({ mode, withSlashMenu }) => {
      // Real mounted owners with synthetic audio/Gateway I/O; this is not a live microphone test.
      const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
      const getUserMedia = vi.fn(async () => audioFixture().stream);
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia },
      });
      onTestFinished(() => {
        if (mediaDescriptor) {
          Object.defineProperty(navigator, "mediaDevices", mediaDescriptor);
        } else {
          Reflect.deleteProperty(navigator, "mediaDevices");
        }
      });
      vi.stubGlobal("AudioContext", MockDictationAudioContext);
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
      vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
      const listeners = new Set<(event: GatewayEventFrame) => void>();
      const client = createTestGatewayClient(async (method) => {
        if (method === "talk.catalog") {
          return { realtime: { ready: false }, transcription: { ready: true } };
        }
        if (method === "talk.config") {
          return { config: {} };
        }
        if (method === "talk.session.create") {
          return {
            sessionId: "escape-capture",
            transcriptionSessionId: "escape-capture",
            audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
          };
        }
        if (method === "talk.session.close" || method === "talk.session.appendAudio") {
          return { ok: true };
        }
        throw new Error(`Unexpected dictation effect: ${method}`);
      });
      client.addEventListener = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      const onAbort = vi.fn();
      let draft = "Keep this draft";
      const draftSource = createComposerDraftSource(() => ({
        draft,
        mentions: [],
        attachments: [],
        pendingAttachmentReads: 0,
      }));
      const onDraftChange = vi.fn((value: string) => {
        draft = value;
        draftSource.publish();
      });
      const view = renderComposer({
        canAbort: true,
        onAbort,
        draft,
        getDraft: () => draft,
        draftSource,
        onDraftChange,
        gatewayClient: client,
        onToggleRealtimeTalk: vi.fn(),
        composerCorrections:
          mode === "explicit" ? { version: 1, mode, locale: "en-US" } : undefined,
        captureDictationDraft: () => draftSource.captureRevision(),
      });
      document.body.append(view.container);
      const state = getChatComposerState(view.props.paneId);
      const dictation = state.dictation;
      if (!dictation) {
        throw new Error("expected the composer dictation owner");
      }
      await waitForSolid(() => expect(state.microphonePicker?.dictationStatus).toBe("ready"));
      const mobileMicrophone = query(
        view.container,
        ".chat-mobile-dictation-action .chat-send-btn--voice",
      );
      expect(mobileMicrophone?.disabled).toBe(false);
      mobileMicrophone!.click();
      await vi.dynamicImportSettled();
      await waitForSolid(() => expect(dictation.connecting).toBe(false));
      expect(dictation.active).toBe(true);
      const stopped = dictation.finishActive();
      const original = "I work Tuesday, no Wednesday shifts are available";
      const retainedListeners = [...listeners];
      expect(retainedListeners.length).toBeGreaterThan(0);
      const deliverRetainedFinal = () => {
        for (const payload of [
          { type: "transcript", text: original, final: true },
          { type: "close", reason: "completed" },
        ]) {
          for (const listener of retainedListeners) {
            listener({
              type: "event",
              event: "talk.event",
              payload: { transcriptionSessionId: "escape-capture", ...payload },
            });
          }
        }
      };
      const cancel = vi.spyOn(dictation, "cancel");
      const escapedToWindow = vi.fn();
      const recordWindowEscape = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          escapedToWindow();
        }
      };
      window.addEventListener("keydown", recordWindowEscape);
      onTestFinished(() => window.removeEventListener("keydown", recordWindowEscape));

      if (mode === "off") {
        // Off releases active capture before its final drain. Escape still belongs to dictation.
        expect(dictation).toMatchObject({
          active: false,
          transcribing: true,
          correctionCommitRequired: false,
          correctionReview: null,
        });
        const event = pressComposerKey(view.container, "Escape");
        expect(event.defaultPrevented).toBe(true);
        expect(onAbort).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledOnce();
        expect(escapedToWindow).not.toHaveBeenCalled();
        // Exercise the actual retained provider callback even after cancellation removes it.
        deliverRetainedFinal();
        await expect(stopped).resolves.toBe(false);
        expect(dictation.transcribing).toBe(false);
        expect(dictation.correctionReview).toBeNull();
        expect(textarea(view.container).value).toBe("Keep this draft");
        expect(draft).toBe("Keep this draft");
        expect(onDraftChange).not.toHaveBeenCalled();
        expect(view.onSend).not.toHaveBeenCalled();
        expect(onAbort).not.toHaveBeenCalled();
        return;
      }

      deliverRetainedFinal();
      await stopped;
      await waitForSolid(() =>
        expect(view.container.querySelector(".composer-correction-review")).not.toBeNull(),
      );
      expect(dictation.correctionReview).toMatchObject({
        original,

        canKeepOriginal: true,
      });
      expect(dictation.active).toBe(false);
      const microphones =
        view.container.querySelectorAll<HTMLButtonElement>(".chat-send-btn--voice");
      expect(microphones).toHaveLength(2);
      for (const microphone of microphones) {
        expect(microphone.disabled).toBe(true);
        expect(microphone.getAttribute("aria-label")).toBe(
          t("chat.corrections.reviewBeforeRecording"),
        );
        microphone.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        microphone.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      }
      expect(dictation.active).toBe(false);
      expect(dictation.correctionCommitRequired).toBe(true);
      expect(getUserMedia).toHaveBeenCalledOnce();
      pressComposerEnter(view.container);
      expect(view.onSend).not.toHaveBeenCalled();
      expect(onDraftChange).not.toHaveBeenCalled();
      if (withSlashMenu) {
        const input = textarea(view.container);
        input.dispatchEvent(
          new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "/" }),
        );
        input.value = "/";
        input.setSelectionRange(1, 1);
        input.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText", data: "/" }),
        );
        await waitForSolid(() => expect(state.slashMenu.state.slashMenuOpen).toBe(true));
        expect(onDraftChange).toHaveBeenCalledOnce();
        expect(draft).toBe("/");
        onDraftChange.mockClear();
        const menuEscape = pressComposerKey(view.container, "Escape");
        expect(menuEscape.defaultPrevented).toBe(true);
        await waitForSolid(() => expect(state.slashMenu.state.slashMenuOpen).toBe(false));
        expect(cancel).not.toHaveBeenCalled();
        expect(onAbort).not.toHaveBeenCalled();
        expect(dictation.correctionCommitRequired).toBe(true);
        expect(dictation.correctionReview?.original).toBe(original);
        // Real input makes insertion stale, but closing its menu must not erase readable recovery.
        expect(dictation.correctionReview?.canKeepOriginal).toBe(false);
        await waitForSolid(() =>
          expect(
            view.container.querySelector(".composer-correction-review")?.textContent,
          ).toContain(original),
        );
        expect(escapedToWindow).toHaveBeenCalledOnce();
        escapedToWindow.mockClear();
      }

      const event = pressComposerKey(view.container, "Escape");
      expect(onAbort).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      expect(escapedToWindow).not.toHaveBeenCalled();
      expect(dictation.correctionCommitRequired).toBe(false);
      expect(dictation.correctionReview).toBeNull();
      expect(textarea(view.container).value).toBe(withSlashMenu ? "/" : "Keep this draft");
      expect(onDraftChange).not.toHaveBeenCalled();
      expect(view.onSend).not.toHaveBeenCalled();
    },
  );

  it("stops an abortable run with Escape unless reply or menu precedence owns it", () => {
    const onAbort = vi.fn();
    let view = renderComposer({ canAbort: true, onAbort });
    let event = pressComposerKey(view.container, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(onAbort).toHaveBeenCalledOnce();

    onAbort.mockClear();
    view = renderComposer({
      canAbort: true,
      onAbort,
      replyTarget: { messageId: "reply-1", text: "Original message" },
    });
    pressComposerKey(view.container, "Escape");
    expect(onAbort).not.toHaveBeenCalled();

    view = renderComposer({ canAbort: true, onAbort });
    const input = textarea(view.container);
    input.value = "/";
    input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true }));
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    event = pressComposerKey(view.container, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("renders the queued author's avatar before the turn is submitted", async () => {
    const part = await renderQueue([
      queued("waiting", {
        sendState: "waiting-idle",
        sender: { id: "alice", name: "Alice Example" },
      }),
    ]);
    await waitForSolid(() =>
      expect(part("item .chat-author-avatar__initials")?.textContent).toContain("AE"),
    );
  });

  it("renders reconnect waits as compact badges without the raw transport error", async () => {
    const error = "chat.send unavailable during gateway restart";
    const part = await renderQueue(
      [queued("reconnect", { sendError: error, sendState: "waiting-reconnect" })],
      { connected: false },
    );
    const item = part("item");
    expect(item?.classList.contains("chat-queue__item--reconnect")).toBe(true);
    const badge = part("badge--reconnect");
    expect(badge?.textContent?.trim()).toBe("Waiting for reconnect");
    expect(badge?.getAttribute("title")).toBe(error);
    expect(item?.querySelectorAll(".chat-queue__badge")).toHaveLength(1);
    for (const hidden of ["error", "state", "global-state"]) {
      expect(part(hidden)).toBeNull();
    }
  });

  it("renders failed sends as retryable and running commands as inert", async () => {
    const onQueueRetry = vi.fn();
    const error = "send blocked by session policy";
    const part = await renderQueue(
      [queued("failed-1", { sendError: error, sendRunId: "run-failed-1", sendState: "failed" })],
      { onQueueRetry },
    );
    await waitForSolid(() => expect(part("badge")?.textContent?.trim()).toBe("Failed"));
    expect(part("error")?.textContent).toContain(error);
    part("retry")?.click();
    expect(onQueueRetry).toHaveBeenCalledWith("failed-1");
    const running = await renderQueue([
      queued("running-command", {
        text: "/compact",
        localCommandName: "compact",
        sendState: "executing-command",
      }),
    ]);
    await waitForSolid(() => expect(running("state")?.textContent?.trim()).toBe("Running command"));
    expect(running("retry")).toBeNull();
    expect(running("remove")).toBeNull();
  });
});
