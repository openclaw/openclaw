/* @vitest-environment jsdom */
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { mountSolid as mountComponent } from "../../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createComposerContainer,
  createComposerProps,
  disposeComposer,
  renderComposerInto,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { createTestChatPane, getPaneTestRuntime } from "./chat-pane.test-support.ts";
import { keepVolatileQueuedMessage } from "./chat-queue.ts";
import { clearSubmittedComposerState, cancelChatDelivery } from "./chat-send-composer.ts";
import { appendChatAttachmentFiles } from "./components/chat-attachments.ts";
import { ComposerDictationSendAction } from "./components/chat-composer-controls.tsx";
import type { ChatComposerProps } from "./components/chat-composer-types.ts";
import { reviewPrivateComposerDraft } from "./components/private-composer-recovery-dialog.tsx";
import { ComposerDictationOwner } from "./composer-dictation.ts";
import {
  admitStoredChatComposerQueueItem,
  persistChatComposerState,
} from "./composer-persistence.ts";

afterEach(() => resetComposerFixture());

function mountComposer(initial: Partial<ChatComposerProps>) {
  const container = document.body.appendChild(createComposerContainer());
  let props = createComposerProps(initial);
  renderComposerInto(container, props);
  const query = container.querySelector.bind(container);
  return {
    container,
    query,
    textarea: () => query<HTMLTextAreaElement>("textarea")!,
    goal: () => query(".agent-chat__goal-mode"),
    update: (next: Partial<ChatComposerProps> = {}) => {
      props = { ...props, ...next };
      renderComposerInto(container, props);
    },
  };
}

function inputEvent(target: HTMLTextAreaElement, value: string, init: InputEventInit = {}) {
  target.value = value;
  target.dispatchEvent(new InputEvent("input", { bubbles: true, ...init }));
}
const composition = (target: HTMLTextAreaElement, type: "start" | "end") =>
  target.dispatchEvent(new CompositionEvent(`composition${type}`, { bubbles: true }));
function retireIme(target: HTMLTextAreaElement) {
  composition(target, "end");
  target.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
}

function mountOwnedComposer(overrides: Partial<ChatComposerProps> = {}) {
  const { pane, state } = createTestChatPane({ client: createTestGatewayClient(async () => ({})) });
  const owner = getPaneTestRuntime(pane).chatState;
  state.sessionKey = "agent:main:draft-source";
  state.chatMessage = overrides.draft ?? "";
  state.chatGoalDraftMode = overrides.goalDraftMode ?? null;
  state.handleChatDraftChange(state.chatMessage);
  const view = mountComposer({
    ...overrides,
    sessionKey: state.sessionKey,
    draftSource: owner.composerDraft,
    getDraft: () => state.chatMessage,
    getMentions: () => state.chatMentions ?? [],
    onDraftChange: state.handleChatDraftChange,
    onGoalDraftModeChange: (mode) => {
      state.chatGoalDraftMode = mode;
      state.handleChatDraftChange(state.chatMessage);
      overrides.onGoalDraftModeChange?.(mode);
    },
  });
  const input = (value: string) => {
    const textarea = view.textarea();
    textarea.focus();
    inputEvent(textarea, value, { inputType: "insertText", data: value.at(-1) });
  };
  const enter = () =>
    view
      .textarea()
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
  return { owner, state, view, input, enter };
}

it("updates edits and history from the draft owner without remounting the input", () => {
  const { owner, state, view } = mountOwnedComposer();
  const textarea = view.textarea();
  inputEvent(textarea, "An ordinary edit", { inputType: "insertText" });
  flush();
  expect(state.chatMessage).toBe("An ordinary edit");

  state.handleChatDraftChange("@Alex restored", [{ profileId: "alex", start: 0, end: 5 }]);
  flush();
  expect(textarea.value).toBe("@Alex restored");
  state.chatLocalInputHistoryBySession[state.sessionKey] = [{ text: "Earlier input", ts: 1 }];
  state.handleChatInputHistoryKey({
    key: "ArrowUp",
    keyCode: 38,
    selectionStart: 0,
    selectionEnd: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
  });
  flush();
  expect(textarea.value).toBe("Earlier input");
  expect(view.textarea()).toBe(textarea);

  const draftChanged = vi.fn();
  onTestFinished(owner.composerDraft.subscribe(draftChanged));
  state.chatStream = "An unrelated response";
  flush();
  expect(draftChanged).not.toHaveBeenCalled();
  expect(view.textarea()).toBe(textarea);
});

it("publishes attachment read progress through the composer owner without a draft edit", async () => {
  const { owner, state, view } = mountOwnedComposer();
  let reportProgress: (() => void) | undefined;
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
    reportProgress = () =>
      this.dispatchEvent(
        new ProgressEvent("progress", { lengthComputable: true, loaded: 1, total: 2 }),
      );
  });
  onTestFinished(() => owner.attachmentReads.abortReads());
  const props = owner.attachmentInputProps(state);
  view.update(props);
  appendChatAttachmentFiles(
    [new File(["progress"], "progress.txt", { type: "text/plain" })],
    props,
  );
  await waitForSolid(() => expect(view.query(".chat-attachment-loading > span")).not.toBeNull());
  reportProgress?.();
  flush();
  expect(view.query<HTMLElement>(".chat-attachment-loading > span")?.style.transform).toBe(
    "scaleX(0.5)",
  );
  expect(view.textarea().value).toBe("");
});

it("publishes submitted and restored drafts without remounting the input", () => {
  const { state, view } = mountOwnedComposer({ draft: "A recoverable draft" });
  state.client = createTestGatewayClient(async () => ({}));
  state.connected = true;
  const textarea = view.textarea();
  const snapshot = clearSubmittedComposerState(state, state.chatMessage, [], [], null);
  expect(state.chatMessage).toBe("");
  flush();
  expect(textarea.value).toBe("");

  const queued = {
    id: "recover-draft",
    text: "A recoverable draft",
    createdAt: 1,
    sendState: "held" as const,
  };
  keepVolatileQueuedMessage(state, state.sessionKey, queued);
  expect(cancelChatDelivery(state, queued, snapshot)).toBe(true);
  expect(state.chatMessage).toBe("A recoverable draft");
  flush();
  expect(textarea.value).toBe("A recoverable draft");
  expect(view.textarea()).toBe(textarea);
});

it("publishes a restored persisted draft and queue after adopting their revision", () => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  const { owner, state, view } = mountOwnedComposer();
  state.client = createTestGatewayClient(async () => ({}));
  state.connected = true;
  expect(persistChatComposerState(state, state.sessionKey, { draft: "Saved draft" })).toBe(true);
  expect(
    admitStoredChatComposerQueueItem(state, captureChatOutboxAdmission(state, state.sessionKey), {
      id: "saved-input",
      text: "Saved queued input",
      createdAt: 1,
      sendState: "held",
    }),
  ).toBe(true);
  state.chatQueue = [];
  const queue = mountSolid(() => (
    <output>{state.chatQueue.map((item) => item.text).join(";")}</output>
  ));
  flush();
  expect(queue.container.textContent).toBe("");
  expect(view.textarea().value).toBe("");
  const textarea = view.textarea();

  expect(owner.composerPersistence.restore()).toBe(true);
  expect(state.chatMessage).toBe("Saved draft");
  expect(state.chatQueue[0]?.text).toBe("Saved queued input");
  flush();
  expect(queue.container.textContent).toBe("Saved queued input");
  expect(view.textarea().value).toBe("Saved draft");
  expect(view.textarea()).toBe(textarea);
});

it("restores the conversation draft when a restored goal edit is cancelled", () => {
  const { state, view } = mountOwnedComposer({
    draft: "Edit this objective",
    goalDraftMode: { action: "edit", goalId: "goal-one", previousDraft: "Conversation draft" },
    onGoalSubmit: vi.fn(async () => false),
  });
  const cancel = view.goal()!.querySelector<HTMLButtonElement>("button")!;
  expect(cancel).not.toBeNull();
  cancel.click();
  flush();
  expect(state.chatGoalDraftMode).toBeNull();
  expect(state.chatMessage).toBe("Conversation draft");
  expect(view.textarea().value).toBe("Conversation draft");
  expect(view.goal()).toBeNull();
});

it("starts a goal and admits only one same-turn submit", async () => {
  const result = createDeferred<boolean>();
  const onGoalSubmit = vi.fn(() => result.promise);
  const { state, view, input, enter } = mountOwnedComposer({ onGoalSubmit });
  input("/goal start ");
  flush();
  expect(state.chatGoalDraftMode).toEqual({ action: "start" });
  expect(view.goal()).not.toBeNull();
  expect(view.textarea().value).toBe("");
  input("Keep every literal space  ");
  flush();
  enter();
  enter();
  view.goal()!.querySelector<HTMLButtonElement>("button")!.click();
  expect(state.chatGoalDraftMode).toEqual({ action: "start" });
  expect(onGoalSubmit).toHaveBeenCalledExactlyOnceWith(
    { action: "start", objective: "Keep every literal space  " },
    expect.any(KeyboardEvent),
  );
  flush();
  expect(view.textarea().readOnly).toBe(true);
  result.resolve(true);
  await waitForSolid(() => expect(state.chatGoalDraftMode).toBeNull());
  expect(view.goal()).toBeNull();
});

it.each(["replacement", "unmount", "remount"])(
  "settles a pending goal after %s",
  async (change) => {
    const result = createDeferred<boolean>();
    const onGoalSubmit = vi.fn(() => result.promise);
    const { state, view, enter } = mountOwnedComposer({
      draft: "Updated objective",
      goalDraftMode: { action: "edit", goalId: "goal-one", previousDraft: "Conversation draft" },
      onGoalSubmit,
    });
    enter();
    if (change === "replacement") {
      state.chatGoalDraftMode = {
        action: "edit",
        goalId: "goal-two",
        previousDraft: "New conversation",
      };
      state.handleChatDraftChange("Replacement objective");
    } else {
      disposeComposer(view.container);
      if (change === "remount") {
        view.update();
        expect(view.textarea().readOnly).toBe(true);
        enter();
        expect(onGoalSubmit).toHaveBeenCalledOnce();
      }
    }
    result.resolve(true);
    await result.promise;
    flush();
    if (change === "replacement") {
      expect(state.chatGoalDraftMode).toMatchObject({ action: "edit", goalId: "goal-two" });
      expect(state.chatMessage).toBe("Replacement objective");
      expect(view.textarea().value).toBe("Replacement objective");
    } else {
      expect(state).toMatchObject({ chatGoalDraftMode: null, chatMessage: "Conversation draft" });
    }
  },
);

it("updates composer text on a live locale change without disturbing an IME draft", async () => {
  onTestFinished(captureI18nStateForTesting());
  await i18n.setLocale("en");
  const onDraftChange = vi.fn();
  const view = mountComposer({
    assistantName: "Locale fixture",
    draft: "Unfinished draft",
    permissionPicker: { canSelectFull: true, onSelect: vi.fn() },
    onDraftChange,
  });
  view.query<HTMLButtonElement>("[data-chat-permission-select]")!.click();
  await waitForSolid(() =>
    expect(view.query(".chat-controls__permission-menu")?.matches(":popover-open")).toBe(true),
  );
  const textarea = view.textarea();
  const heading = view.query(".chat-controls__permission-heading")!;
  expect(heading.textContent).toBe("Execution permissions");
  expect(textarea.placeholder).toBe("Message Locale fixture");

  textarea.focus();
  composition(textarea, "start");
  textarea.value = "Unfinished 日本語";
  textarea.setSelectionRange(11, 14);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
  const writes = vi.spyOn(HTMLTextAreaElement.prototype, "value", "set");

  await i18n.setLocale("de");
  flush();

  expect(heading.textContent).toBe("Ausführungsberechtigungen");
  expect(textarea.placeholder).toBe("Nachricht an Locale fixture");
  expect(view.query(".chat-controls__permission-heading")).toBe(heading);
  expect(view.textarea()).toBe(textarea);
  expect(document.activeElement).toBe(textarea);
  expect(textarea.value).toBe("Unfinished 日本語");
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([11, 14]);
  expect(writes).not.toHaveBeenCalled();
  expect(onDraftChange).not.toHaveBeenCalled();
});

it("updates an existing private draft recovery error when the locale changes", async () => {
  onTestFinished(captureI18nStateForTesting());
  await i18n.setLocale("en");
  const controller = new AbortController();
  const review = reviewPrivateComposerDraft({
    text: "Recover this draft",
    attachments: [{ id: "unavailable", fileName: "draft.txt", mimeType: "text/plain" }],
    hasGoal: false,
    pendingReads: 0,
    isCurrent: () => true,
    signal: controller.signal,
  });
  onTestFinished(async () => {
    controller.abort();
    await review;
  });
  const download = await waitForSolid(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Download draft.txt",
    );
    expect(button).toBeDefined();
    return button!;
  });
  download.click();
  flush();
  const error = document.querySelector('[role="alert"]')!;
  expect(error.textContent).toBe(
    "This attachment is no longer available to download. Keep the draft open and recover the original file before discarding it.",
  );

  await i18n.setLocale("de");
  flush();

  expect(document.querySelector('[role="alert"]')).toBe(error);
  expect(error.textContent).toBe(
    "Dieser Anhang kann nicht mehr heruntergeladen werden. Lassen Sie den Entwurf geöffnet und stellen Sie die Originaldatei wieder her, bevor Sie ihn verwerfen.",
  );
});

it("retains the native input and IME draft across external composer updates", () => {
  let draft = "hello";
  const onDraftChange = vi.fn((value: string) => {
    draft = value;
  });
  const view = mountComposer({ draft, getDraft: () => draft, onDraftChange });
  const textarea = view.textarea();
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!;
  const setValue = vi.spyOn(HTMLTextAreaElement.prototype, "value", "set");
  const edit = (value: string, composing = false) => {
    nativeValue.set!.call(textarea, value);
    textarea.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", isComposing: composing }),
    );
  };

  edit("hello there");
  view.update({ stream: "Streaming a response", runActive: true });
  flush();
  expect(view.textarea()).toBe(textarea);
  expect(textarea.value).toBe("hello there");
  expect(setValue).not.toHaveBeenCalled();

  composition(textarea, "start");
  edit("hello 日本語", true);
  onDraftChange.mockClear();
  view.update({ draft: "stale host snapshot", stream: "More response" });
  flush();
  expect(view.textarea()).toBe(textarea);
  expect(textarea.value).toBe("hello 日本語");
  expect(setValue).not.toHaveBeenCalled();
  expect(onDraftChange).not.toHaveBeenCalled();

  composition(textarea, "end");
  expect(onDraftChange).toHaveBeenCalledWith("hello 日本語", undefined);
  expect(setValue).not.toHaveBeenCalled();
});

it("ends the old IME scope without writing into a newly selected session", () => {
  const onOldDraftChange = vi.fn();
  const onNewDraftChange = vi.fn();
  const view = mountComposer({
    sessionKey: "first",
    draft: "first draft",
    onDraftChange: onOldDraftChange,
  });
  const oldInput = view.textarea();
  composition(oldInput, "start");
  inputEvent(oldInput, "unfinished composition", { isComposing: true });

  view.update({ sessionKey: "second", draft: "second draft", onDraftChange: onNewDraftChange });
  flush();
  const newInput = view.textarea();
  expect(newInput).not.toBe(oldInput);
  expect(newInput.value).toBe("second draft");
  retireIme(oldInput);
  expect(onOldDraftChange).not.toHaveBeenCalled();
  expect(onNewDraftChange).not.toHaveBeenCalled();
  expect(newInput.value).toBe("second draft");

  inputEvent(newInput, "second draft edited", { inputType: "insertText" });
  expect(onNewDraftChange).toHaveBeenCalledWith("second draft edited", undefined);
});

it("retires an unfinished IME gesture when the same pane composer remounts", () => {
  const { state, view, input } = mountOwnedComposer({ draft: "Canonical draft" });
  const oldInput = view.textarea();
  composition(oldInput, "start");
  inputEvent(oldInput, "Unfinished composition", { isComposing: true });
  disposeComposer(view.container);
  view.update();

  const newInput = view.textarea();
  expect(newInput).not.toBe(oldInput);
  expect(newInput.value).toBe("Canonical draft");
  input("Typing after remount");
  flush();
  expect(state.chatMessage).toBe("Typing after remount");
  retireIme(oldInput);
  expect(state.chatMessage).toBe("Typing after remount");
});

it("keeps the open permission picker through parent updates", async () => {
  const permissionPicker = { canSelectFull: true, onSelect: vi.fn() };
  const view = mountComposer({ permissionPicker });
  const picker = view.query(".chat-controls__permission-picker")!;
  const trigger = picker.querySelector<HTMLButtonElement>("[data-chat-permission-select]")!;
  trigger.click();
  const surface = picker.querySelector<HTMLElement>('[role="menu"]')!;
  await waitForSolid(() => expect(surface.matches(":popover-open")).toBe(true));
  view.update({ stream: "More response", permissionPicker: { ...permissionPicker } });
  flush();
  expect(view.query(".chat-controls__permission-picker")).toBe(picker);
  expect(picker.querySelector('[role="menu"]')).toBe(surface);
  expect(surface.matches(":popover-open")).toBe(true);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
});

it("keeps a pending dictation send bound to the action that started it", async () => {
  const controller = new ComposerDictationOwner({
    client: null,
    connected: false,
    enabled: false,
    realtimeTalkActive: false,
    onCommit: () => {},
    onError: () => {},
  });
  vi.spyOn(controller, "active", "get").mockReturnValue(true);
  const finish = createDeferred<boolean>();
  vi.spyOn(controller, "finishActive").mockReturnValue(finish.promise);
  const firstSend = vi.fn();
  const laterSend = vi.fn();
  const view = mountComponent(ComposerDictationSendAction, {
    readDictation: () => controller,
    onSend: firstSend,
  });
  onTestFinished(() => controller.dispose());
  view.container.querySelector<HTMLButtonElement>("button")!.click();
  view.update({ readDictation: () => controller, onSend: laterSend });
  finish.resolve(true);
  await Promise.resolve();
  expect(firstSend).toHaveBeenCalledOnce();
  expect(laterSend).not.toHaveBeenCalled();
});
