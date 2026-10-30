/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { t } from "../../i18n/index.ts";
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
    expect(stop.getAttribute("aria-label")).toBe(t("chat.runControls.stopGenerating"));
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
    const update = vi.spyOn(dictation, "update");
    renderComposerInto(container, props);
    const commit = update.mock.lastCall?.[0].onCommit;
    if (!commit) {
      throw new Error("expected the composer transcript callback");
    }
    return { container, active, locked, finishActive, onSend, commit };
  }

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

  it("keeps Stop and Send mounted but aria-disabled while dictation finalizes", () => {
    const { container } = renderDictatingComposer({ finalizing: true });

    for (const kind of ["dictating", "dictation-commit"]) {
      const action = query(container, `.chat-send-btn--${kind}`);
      expect(action?.disabled).toBe(false);
      expect(action?.getAttribute("aria-disabled")).toBe("true");
    }
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
