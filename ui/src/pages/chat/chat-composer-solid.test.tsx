import { render, nothing } from "lit";
/* @vitest-environment jsdom */
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerProps,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { renderComposerDictationSendAction } from "./components/chat-composer-controls.tsx";
import { renderChatComposer } from "./components/chat-composer.tsx";
import { ComposerDictationController } from "./composer-dictation.ts";

afterEach(() => resetComposerFixture());

function mountComposer(initial: Parameters<typeof renderChatComposer>[0]) {
  const container = document.body.appendChild(createComposerContainer());
  let props = initial;
  const paint = () => render(renderChatComposer(props), container);
  onTestFinished(() => {
    render(nothing, container);
  });
  paint();
  return {
    container,
    update: (next: (previous: typeof props) => typeof props) => {
      props = next(props);
      paint();
    },
  };
}

it("retains the native input and IME draft across external composer updates", () => {
  let draft = "hello";
  const onDraftChange = vi.fn((value: string) => {
    draft = value;
  });
  const view = mountComposer(
    createComposerProps({
      draft,
      getDraft: () => draft,
      onDraftChange,
    }),
  );
  const textarea = view.container.querySelector("textarea")!;
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!;
  const setValue = vi.spyOn(HTMLTextAreaElement.prototype, "value", "set");
  const edit = (value: string, composing = false) => {
    nativeValue.set!.call(textarea, value);
    textarea.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", isComposing: composing }),
    );
  };

  edit("hello there");
  view.update((previous) => ({ ...previous, stream: "Streaming a response", runActive: true }));
  flush();
  expect(view.container.querySelector("textarea")).toBe(textarea);
  expect(textarea.value).toBe("hello there");
  expect(setValue).not.toHaveBeenCalled();

  textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  edit("hello 日本語", true);
  onDraftChange.mockClear();
  view.update((previous) => ({
    ...previous,
    draft: "stale host snapshot",
    stream: "More response",
  }));
  flush();
  expect(view.container.querySelector("textarea")).toBe(textarea);
  expect(textarea.value).toBe("hello 日本語");
  expect(setValue).not.toHaveBeenCalled();
  expect(onDraftChange).not.toHaveBeenCalled();

  textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  expect(onDraftChange).toHaveBeenCalledWith("hello 日本語", undefined);
  expect(setValue).not.toHaveBeenCalled();
});

it("ends the old IME scope without writing into a newly selected session", () => {
  const onOldDraftChange = vi.fn();
  const onNewDraftChange = vi.fn();
  const view = mountComposer(
    createComposerProps({
      sessionKey: "first",
      draft: "first draft",
      onDraftChange: onOldDraftChange,
    }),
  );
  const oldInput = view.container.querySelector("textarea")!;
  oldInput.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  oldInput.value = "unfinished composition";
  oldInput.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));

  view.update((previous) => ({
    ...previous,
    sessionKey: "second",
    draft: "second draft",
    onDraftChange: onNewDraftChange,
  }));
  flush();
  const newInput = view.container.querySelector("textarea")!;
  expect(newInput).not.toBe(oldInput);
  expect(newInput.value).toBe("second draft");
  oldInput.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  oldInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  expect(onOldDraftChange).not.toHaveBeenCalled();
  expect(onNewDraftChange).not.toHaveBeenCalled();
  expect(newInput.value).toBe("second draft");

  newInput.value = "second draft edited";
  newInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  expect(onNewDraftChange).toHaveBeenCalledWith("second draft edited", undefined);
});

it("updates follow-up controls during IME without replacing or writing the input", () => {
  const onDraftChange = vi.fn();
  const props = createComposerProps({
    canAbort: true,
    onAbort: vi.fn(),
    runActive: true,
    stream: "Reply in progress",
    followUpMode: "queue",
    onDraftChange,
  });
  const view = mountComposer(props);
  const textarea = view.container.querySelector("textarea")!;
  expect(view.container.querySelector(".chat-send-btn--stop")).not.toBeNull();
  textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  textarea.value = "Composing a follow-up";
  const writes = vi.spyOn(HTMLTextAreaElement.prototype, "value", "set");
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
  flush();
  const send = view.container.querySelector<HTMLButtonElement>(".chat-send-btn--send");
  expect(send).not.toBeNull();
  expect(send?.disabled).toBe(false);
  expect(view.container.querySelector("textarea")).toBe(textarea);
  expect(textarea.value).toBe("Composing a follow-up");
  expect(writes).not.toHaveBeenCalled();
  expect(onDraftChange).not.toHaveBeenCalled();
});

it("keeps the open permission picker through parent updates", () => {
  const permissionPicker = { canSelectFull: true, onSelect: vi.fn() };
  const view = mountComposer(createComposerProps({ permissionPicker }));
  const picker = view.container.querySelector<HTMLElement & { open: boolean }>(
    ".chat-controls__permission-picker",
  )!;
  picker.open = true;
  view.update((previous) => ({
    ...previous,
    stream: "More response",
    permissionPicker: { ...permissionPicker },
  }));
  flush();
  expect(view.container.querySelector(".chat-controls__permission-picker")).toBe(picker);
  expect(picker.open).toBe(true);
});

it("keeps a pending dictation send bound to the action that started it", async () => {
  const controller = new ComposerDictationController({
    client: null,
    connected: false,
    enabled: false,
    realtimeTalkActive: false,
    onCommit: () => {},
    onError: () => {},
    onStateChange: () => {},
  });
  vi.spyOn(controller, "active", "get").mockReturnValue(true);
  let finish!: (value: boolean) => void;
  vi.spyOn(controller, "finishActive").mockReturnValue(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  const firstSend = vi.fn();
  const laterSend = vi.fn();
  const view = mountSolid(() => <section />);
  const outlet = view.container.querySelector("section")!;
  try {
    render(renderComposerDictationSendAction(controller, firstSend), outlet);
    outlet.querySelector<HTMLButtonElement>("button")!.click();
    render(renderComposerDictationSendAction(controller, laterSend), outlet);
    finish(true);
    await Promise.resolve();
    expect(firstSend).toHaveBeenCalledOnce();
    expect(laterSend).not.toHaveBeenCalled();
  } finally {
    render(nothing, outlet);
    controller.dispose();
  }
});
