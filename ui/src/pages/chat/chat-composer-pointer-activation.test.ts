/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import {
  findComposerButton,
  createComposerContainer,
  createComposerProps,
  renderComposerInto,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";

function pointerDown(target: HTMLElement) {
  const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
  target.dispatchEvent(event);
  return event;
}
function mount(overrides: Parameters<typeof createComposerProps>[0] = {}, attached = true) {
  const container = createComposerContainer();
  if (attached) {
    document.body.append(container);
  }
  const props = createComposerProps(overrides);
  renderComposerInto(container, props);
  const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(input).not.toBeNull();
  const button = (stop = false) =>
    findComposerButton(
      container,
      t(stop ? "chat.runControls.stopGenerating" : "chat.runControls.sendMessage"),
    );
  return { container, props, input, button };
}
function editable(initial: string) {
  let draft = initial;
  const onSend = vi.fn(() => {
    draft = "";
  });
  return {
    ...mount({
      draft,
      getDraft: () => draft,
      onDraftChange: (value) => {
        draft = value;
      },
      onSend,
    }),
    onSend,
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

function keyEvent(type = "keydown", options: KeyboardEventInit = {}) {
  return new KeyboardEvent(type, { key: "Enter", bubbles: true, cancelable: true, ...options });
}
function timedEnter(end: Event, offset: number, options: KeyboardEventInit = {}) {
  return Object.defineProperty(keyEvent("keydown", options), "timeStamp", {
    value: end.timeStamp + offset,
  });
}

it.each(["keyup", "blur", "keydown"])(
  "allows an immediate deliberate Enter after %s without affecting another composer",
  (type) => {
    const first = mount({ draft: "日本語" }, false);
    const second = mount({ draft: "another draft" }, false);
    const end = new CompositionEvent("compositionend", { bubbles: true });
    first.input.dispatchEvent(end);
    const enter = () => timedEnter(end, 1, { cancelable: false });
    second.input.dispatchEvent(enter());
    expect(second.props.onSend).toHaveBeenCalledOnce();
    expect(first.props.onSend).not.toHaveBeenCalled();
    first.input.dispatchEvent(
      type === "blur"
        ? new FocusEvent("blur")
        : keyEvent(type, { key: type === "keydown" ? "Meta" : "Enter", cancelable: false }),
    );
    first.input.dispatchEvent(enter());
    expect(first.props.onSend).toHaveBeenCalledOnce();
  },
);

it.each([
  { sendShortcut: "enter", modifiers: {}, confirmOffset: -1 },
  { sendShortcut: "enter", modifiers: {}, confirmOffset: 1 },
  { sendShortcut: "modifier-enter", modifiers: { ctrlKey: true }, confirmOffset: 1 },
  { sendShortcut: "modifier-enter", modifiers: { metaKey: true }, confirmOffset: 1 },
] as const)(
  "keeps a Safari composition-confirm Enter in the draft: %j",
  ({ sendShortcut, modifiers, confirmOffset }) => {
    const { container, props, input } = mount({ sendShortcut }, false);
    input.style.height = "42px";
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    for (const value of ["shi", "shichang"]) {
      input.value = value;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    }
    expect(input.style.height).toBe("42px");
    input.value = "日本語";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    const end = new CompositionEvent("compositionend", { bubbles: true, data: "日本語" });
    input.dispatchEvent(end);
    expect(input.style.height).not.toBe("42px");
    renderComposerInto(container, { ...props, draft: "日本語" });
    for (const offset of [confirmOffset, 99, 100]) {
      const enter = timedEnter(end, offset, { keyCode: 13, ...modifiers });
      input.dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(offset === 100);
      expect(props.onSend).toHaveBeenCalledTimes(offset === 100 ? 1 : 0);
      if (offset !== 100) {
        expect(input.value).toBe("日本語");
      }
    }
    expect(props.onDraftChange).toHaveBeenCalledWith("日本語", undefined);
  },
);

it("leaves active IME keys to the browser and recovers Enter-send after blur", () => {
  const onHistoryKeydown = vi.fn(() => ({
    handled: true,
    preventDefault: true,
    restoreCaret: null,
  }));
  const { input, props } = mount({ onHistoryKeydown, draft: "hello" }, false);
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  input.value = "dangqian";
  for (const key of ["Enter", "ArrowUp"]) {
    const event = keyEvent("keydown", { key });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(props.onSend).not.toHaveBeenCalled();
  expect(onHistoryKeydown).not.toHaveBeenCalled();
  expect(input.value).toBe("dangqian");
  input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  const enterEvent = keyEvent();
  input.dispatchEvent(enterEvent);
  expect(enterEvent.defaultPrevented).toBe(true);
  expect(props.onSend).toHaveBeenCalledOnce();
});
