/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { t } from "../../i18n/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  findComposerButton as button,
  findPrimaryButton as primaryButton,
  renderComposerFixture,
  resetComposerFixture,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import type { ChatComposerProps } from "./components/chat-composer-types.ts";

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

describe("renderChatComposer controls", () => {
  it("keeps an editable draft without send permission", () => {
    const draft = "local draft";
    const { container, onSend } = renderComposer({ canCompose: true, canSend: false, draft });
    expect(textarea(container).disabled).toBe(false);
    const send = primaryButton(container);
    expect(send.disabled).toBe(true);
    send.click();
    pressComposerEnter(container);
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea(container).value).toBe(draft);
  });

  it("keeps desktop and mobile Stop available with a pending attachment", () => {
    const onAbort = vi.fn();
    const { container, props, onSend, onDraftChange } = renderComposer({
      canAbort: true,
      canCompose: true,
      draft: "Keep this draft",
      onAbort,
      pendingAttachmentReads: 1,
    });
    const stop = primaryButton(container);

    expect(stop.getAttribute("aria-label")).toBe(t("chat.runControls.stopGenerating"));
    expect(stop.disabled).toBe(false);
    expect(query(container, ".chat-mobile-primary-action > openclaw-tooltip > button")).toBe(stop);
    expect(container.querySelectorAll(".chat-send-btn--stop")).toHaveLength(1);
    stop.click();
    expect(onAbort).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(textarea(container).value).toBe(props.draft);
  });

  it("keeps command submission gated after history failed", () => {
    const reason = "History failed. Retry to load the conversation.";
    const { container, onSend } = renderComposer({
      draft: "/compact",
      submitDisabledReason: reason,
      submitPending: false,
    });
    const send = primaryButton(container);
    expect(send.disabled).toBe(true);
    expect(send.getAttribute("aria-label")).toBe(reason);
    expect(send.getAttribute("aria-busy")).toBe("false");
    expect(send.querySelector(".btn__spinner")).toBeNull();
    send.click();
    pressComposerEnter(container);
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea(container).value).toBe("/compact");
  });

  function renderDictatingComposer({
    submitDisabledReason,
    finalizing = false,
  }: { submitDisabledReason?: string; finalizing?: boolean } = {}) {
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
    vi.spyOn(dictation, "finalizing", "get").mockReturnValue(finalizing);
    const finishActive = vi.spyOn(dictation, "finishActive").mockResolvedValue(true);
    const handleClick = vi.spyOn(dictation, "handleClick");
    const update = vi.spyOn(dictation, "update");
    renderComposerInto(container, props);
    const commit = update.mock.lastCall?.[0].onCommit;
    if (!commit) {
      throw new Error("expected the composer transcript callback");
    }
    return { container, active, locked, finishActive, handleClick, onSend, commit };
  }

  it("stops dictation by keeping its text without sending", () => {
    const { container, finishActive, handleClick, onSend } = renderDictatingComposer();
    const stop = query(container, ".chat-send-btn--dictating");

    expect(stop?.getAttribute("aria-label")).toBe("Stop and keep text");
    stop?.click();

    expect(finishActive).toHaveBeenCalledOnce();
    expect(handleClick).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("finishes locked dictation before submitting the complete draft with history held", async () => {
    const { container, active, locked, finishActive, onSend, commit } = renderDictatingComposer({
      submitDisabledReason: "Loading chat",
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

  it("keeps Stop and Send visually stable while dictation finalizes", () => {
    const { container } = renderDictatingComposer({ finalizing: true });

    const stop = query(container, ".chat-send-btn--dictating");
    const send = query(container, ".chat-send-btn--dictation-commit");
    expect(stop?.getAttribute("aria-label")).toBe("Stop and keep text");
    expect(stop?.disabled).toBe(false);
    expect(stop?.getAttribute("aria-disabled")).toBe("true");
    expect(stop?.querySelector("rect")).not.toBeNull();
    expect(send?.classList.contains("chat-send-btn--send")).toBe(true);
    expect(send?.disabled).toBe(false);
    expect(send?.getAttribute("aria-disabled")).toBe("true");
    expect(send?.querySelector("path")?.getAttribute("d")).toBe("M12 19V5m-7 7 7-7 7 7");
  });

  it("keeps voice and generation stop controls distinct when both are active", () => {
    const onAbort = vi.fn();
    const onToggleRealtimeTalk = vi.fn();
    const { container } = renderComposer({
      canAbort: true,
      onAbort,
      onToggleRealtimeTalk,
      realtimeTalkActive: true,
    });

    const stopVoice = button(container, t("chat.composer.stopVoiceInput"));
    const stopGeneration = button(container, t("chat.runControls.stopGenerating"));
    expect(stopVoice.classList.contains("chat-send-btn--voice-live")).toBe(true);
    expect(stopVoice.classList.contains("chat-send-btn--stop")).toBe(false);
    expect(stopGeneration.classList.contains("chat-send-btn--stop")).toBe(true);
    expect(stopGeneration.closest(".chat-mobile-primary-action")).not.toBeNull();
    expect(container.querySelectorAll(".chat-send-btn--stop")).toHaveLength(1);
    stopVoice.click();
    stopGeneration.click();
    expect(onToggleRealtimeTalk).toHaveBeenCalledOnce();
    expect(onAbort).toHaveBeenCalledOnce();
  });

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

  it("queues ordinary drafts offline but disables live voice", () => {
    let view = renderComposer({ connected: false, draft: "queue this" });
    const send = button(view.container, t("chat.runControls.sendMessage"));
    expect(send.disabled).toBe(false);
    send.click();
    expect(view.onSend).toHaveBeenCalledOnce();

    view = renderComposer({ connected: false, onToggleRealtimeTalk: vi.fn() });
    expect(button(view.container, t("chat.composer.startVoiceInput")).disabled).toBe(true);
  });

  it("offers Steer only for eligible queued messages during an active run", () => {
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
    const steer = [...container.querySelectorAll<HTMLButtonElement>(".chat-queue__action")];
    expect(steer).toHaveLength(2);
    steer[0]?.click();
    steer[1]?.click();
    expect(onQueueSteer.mock.calls).toEqual([["queued-1"], ["waiting-idle-1"]]);
  });

  it("steers empty Enter on a new press", () => {
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
    const event = pressComposerEnter(container, { repeat: false });

    expect(event.defaultPrevented).toBe(true);
    expect(onQueueSteer.mock.calls).toEqual([["pending-unscoped"]]);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not steer from Enter while admission is held", () => {
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
      const { container, onSend } = renderComposer({
        ...activeRun(),
        draft,
        followUpMode,
        getAttachments,
        sendShortcut: "enter",
      });
      if (liveDraft !== undefined) {
        textarea(container).value = liveDraft;
      }

      const action = pressComposerEnter(container, { ctrlKey: true });
      expect(onSend).toHaveBeenCalledOnce();
      expect(onSend).toHaveBeenCalledWith(alternateMode, action);

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
      expect(tooltip?.content).toBe(expected);
    }
  });

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
    const { container } = renderComposer({
      queue: [
        queued("waiting-idle-1", {
          createdAt: 4,
          sendState: "waiting-idle",
          sender: { id: "profile_123", name: "Alice Example" },
        }),
      ],
    });

    await vi.waitFor(() => {
      expect(
        query(container, ".chat-queue__item .chat-author-avatar__initials")?.textContent,
      ).toContain("AE");
    });
  });

  it("renders reconnect waits as compact badges without the raw transport error", () => {
    const { container } = renderComposer({
      connected: false,
      queue: [
        queued("reconnect-1", {
          sendError: "chat.send unavailable during gateway restart",
          sendState: "waiting-reconnect",
        }),
      ],
    });
    const item = container.querySelector(".chat-queue__item");
    expect(item?.classList.contains("chat-queue__item--reconnect")).toBe(true);
    expect(
      item?.querySelector('.chat-queue__icon path[d="M21 5v12a2 2 0 0 1-2 2h-6"]'),
    ).not.toBeNull();
    expect(item?.querySelector(".chat-queue__error")).toBeNull();
    const state = item?.querySelector(".chat-queue__badge--reconnect");
    expect(state?.textContent?.trim()).toBe("Waiting for reconnect");
    expect(state?.getAttribute("title")).toBe("chat.send unavailable during gateway restart");
  });

  it("renders failed sends as retryable and running commands as inert", () => {
    const onQueueRetry = vi.fn();
    let view = renderComposer({
      onQueueRetry,
      queue: [
        queued("failed-1", {
          sendError: "send blocked by session policy",
          sendRunId: "run-failed-1",
          sendState: "failed",
        }),
      ],
    });
    expect(query(view.container, ".chat-queue__badge")?.textContent?.trim()).toBe("Failed");
    expect(query(view.container, ".chat-queue__error")?.textContent).toContain(
      "send blocked by session policy",
    );
    query(view.container, ".chat-queue__retry")?.click();
    expect(onQueueRetry).toHaveBeenCalledWith("failed-1");

    view = renderComposer({
      queue: [
        queued("running-command", {
          text: "/compact",
          localCommandName: "compact",
          sendState: "executing-command",
        }),
      ],
    });
    expect(query(view.container, ".chat-queue__state")?.textContent?.trim()).toBe(
      "Running command",
    );
    expect(query(view.container, ".chat-queue__retry")).toBeNull();
    expect(query(view.container, ".chat-queue__remove")).toBeNull();
  });
});
