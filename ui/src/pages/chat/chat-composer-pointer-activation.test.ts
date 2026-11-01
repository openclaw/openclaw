/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import {
  createComposerContainer,
  createComposerProps,
  findComposerButton,
  renderComposerInto,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";

function pointerDown(target: HTMLElement) {
  const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
  target.dispatchEvent(event);
  return event;
}
function mount(overrides: Parameters<typeof createComposerProps>[0] = {}) {
  const container = document.body.appendChild(createComposerContainer());
  renderComposerInto(container, createComposerProps(overrides));
  const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(input).not.toBeNull();
  const button = (stop = false) =>
    findComposerButton(
      container,
      t(stop ? "chat.runControls.stopGenerating" : "chat.runControls.sendMessage"),
    );
  return { container, input, button };
}
function editable(initial: string, trackTyping = false) {
  let draft = initial;
  const onSend = vi.fn(() => {
    draft = "";
  });
  const onTypingChange = vi.fn();
  return {
    ...mount({
      draft,
      getDraft: () => draft,
      onDraftChange: (value) => {
        draft = value;
      },
      onSend,
      onTypingChange: trackTyping ? onTypingChange : undefined,
    }),
    onSend,
    onTypingChange,
  };
}
afterEach(() => resetComposerFixture());

it("does not steal focus when a menu replaces the clicked content", () => {
  const { container, input } = mount({ draft: "Keep this draft" });
  const focus = vi.spyOn(input, "focus");
  const menu = container.querySelector(".agent-chat__capability-menu .oc-menu")!;
  const label = menu.appendChild(document.createElement("span"));
  label.addEventListener("click", () => label.remove());
  label.click();
  expect(label.isConnected).toBe(false);
  expect(focus).not.toHaveBeenCalled();
  expect(input.value).toBe("Keep this draft");
  container.querySelector<HTMLElement>(".agent-chat__input")!.click();
  expect(document.activeElement).toBe(input);
});

it("preserves only its own textarea focus during primary pointer actions", () => {
  const send = mount({ canAbort: true, draft: "Follow up", onAbort: vi.fn(), onSend: vi.fn() });
  send.input.focus();
  // Native target listeners precede Solid's delegated bubble handler.
  send.button().addEventListener("pointerdown", () => send.input.blur(), { once: true });
  expect(pointerDown(send.button()).defaultPrevented).toBe(true);
  const stop = mount({ canAbort: true, onAbort: vi.fn() });
  stop.input.focus();
  expect(pointerDown(stop.button(true)).defaultPrevented).toBe(true);
  document.body.appendChild(document.createElement("input")).focus();
  expect(pointerDown(send.button()).defaultPrevented).toBe(false);
});

it.each([false, true])("retains focus after activation (stop=%s)", (stop) => {
  const onAbort = vi.fn();
  const stoppedTyping = vi.fn();
  const view = stop
    ? {
        ...mount({ canAbort: true, onAbort, onTypingChange: stoppedTyping }),
        onSend: onAbort,
        onTypingChange: stoppedTyping,
      }
    : editable("Send this", true);
  view.input.focus();
  pointerDown(view.button(stop));
  view.button(stop).click();
  expect(view.onSend).toHaveBeenCalledOnce();
  expect(view.input.value).toBe("");
  expect(document.activeElement).toBe(view.input);
  if (stop) {
    expect(view.onTypingChange).not.toHaveBeenCalled();
  } else {
    expect(view.onTypingChange).toHaveBeenLastCalledWith(false);
  }
});

it("does not leave composition state stuck after pointer Send", () => {
  const { input, button, onSend } = editable("構成中");
  input.focus();
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  pointerDown(button());
  button().click();
  expect(onSend).toHaveBeenCalledOnce();
  input.value = "next";
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  input.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
  );
  expect(onSend).toHaveBeenCalledTimes(2);
});
