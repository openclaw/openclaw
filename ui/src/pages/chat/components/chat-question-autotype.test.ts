/* @vitest-environment jsdom */

import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { focusChatComposerFromPrintableKeydown } from "../chat-pane-shared.ts";
import type { QuestionPanelProps } from "./chat-question-card.ts";
import { ChatQuestionPanel } from "./chat-question-panel.ts";

const listeners: Array<(event: KeyboardEvent) => void> = [];
afterEach(() => {
  for (const listener of listeners.splice(0)) {
    document.removeEventListener("keydown", listener, true);
  }
  document.body.replaceChildren();
});

async function mountQuestion() {
  const root = document.body.appendChild(document.createElement("div"));
  const wrapper = root.appendChild(document.createElement("div"));
  wrapper.className = "agent-chat__composer-combobox";
  const composer = wrapper.appendChild(document.createElement("textarea"));
  composer.value = "kept draft";
  const panel = root.appendChild(new ChatQuestionPanel());
  const onSubmit = vi.fn();
  const props: QuestionPanelProps = {
    model: {
      requestKey: "optional-keyboard",
      title: "Choose a format",
      collapsed: true,
      autoFocus: false,
      nonBlocking: true,
      disabled: false,
      questions: [
        {
          questionId: "format",
          header: "Format",
          question: "Which format?",
          isOther: true,
          options: [{ label: "Compact" }, { label: "Detailed" }],
        },
      ],
      drafts: new Map([["format", { selected: new Set(["Compact"]), freeText: "" }]]),
    },
    onSubmit,
    onCollapsedChange(collapsed) {
      panel.props = { ...panel.props!, model: { ...panel.props!.model, collapsed } };
    },
  };
  panel.props = props;
  await panel.updateComplete;
  composer.focus();
  expect(document.activeElement).toBe(composer);
  const capture = (event: KeyboardEvent) => focusChatComposerFromPrintableKeydown(root, event);
  document.addEventListener("keydown", capture, true);
  listeners.push(capture);
  panel.querySelector<HTMLButtonElement>(".chat-question-panel__collapsed-button")!.click();
  await panel.updateComplete;
  const group = panel.querySelector<HTMLElement>(".chat-question-panel")!;
  assert(group.isConnected);
  expect(document.activeElement).toBe(group);
  expect(composer.isConnected && !composer.disabled && !composer.readOnly).toBe(true);
  return { root, panel, group, composer, props, onSubmit };
}

it.each(["group", "option"])("keeps optional option key 2 at the focused %s", async (focus) => {
  const { panel, group, composer, props } = await mountQuestion();
  const target =
    focus === "group" ? group : panel.querySelector<HTMLButtonElement>("[data-option-index='0']")!;
  target.focus();
  const reached = vi.fn();
  group.addEventListener("keydown", reached);
  const event = new KeyboardEvent("keydown", {
    key: "2",
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  target.dispatchEvent(event);
  await panel.updateComplete;
  expect([...props.model.drafts.get("format")!.selected]).toEqual(["Detailed"]);
  expect(document.activeElement).toBe(target);
  expect(reached).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(true);
  expect(composer.value).toBe("kept draft");
});

it("keeps the optional Other key 3 at the reopened panel", async () => {
  const { panel, group, composer } = await mountQuestion();
  const event = new KeyboardEvent("keydown", {
    key: "3",
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  group.dispatchEvent(event);
  await panel.updateComplete;
  expect(document.activeElement).toBe(panel.querySelector("textarea"));
  expect(event.defaultPrevented).toBe(true);
  expect(composer.value).toBe("kept draft");
});

it.each(["2", "3"])(
  "leaves a blocking panel key %s to its owner without a mounted composer",
  async (key) => {
    const { panel, group, composer, props } = await mountQuestion();
    panel.props = { ...panel.props!, model: { ...panel.props!.model, nonBlocking: false } };
    composer.parentElement!.remove();
    await panel.updateComplete;
    group.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true }),
    );
    await panel.updateComplete;
    expect(composer.isConnected).toBe(false);
    if (key === "2") {
      expect([...props.model.drafts.get("format")!.selected]).toEqual(["Detailed"]);
    } else {
      expect(document.activeElement).toBe(panel.querySelector("textarea"));
    }
  },
);

it.each(["disabled", "readOnly"] as const)(
  "does not redirect when the composer is %s",
  async (property) => {
    const { panel, group, composer, props } = await mountQuestion();
    composer[property] = true;
    group.dispatchEvent(
      new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true, composed: true }),
    );
    await panel.updateComplete;
    expect([...props.model.drafts.get("format")!.selected]).toEqual(["Detailed"]);
    expect(document.activeElement).toBe(group);
  },
);

it.each(["ctrlKey", "metaKey", "altKey", "isComposing"])(
  "preserves the current owner for %s",
  async (modifier) => {
    const { panel, group, composer, props } = await mountQuestion();
    const reached = vi.fn();
    group.addEventListener("keydown", reached);
    const event = new KeyboardEvent("keydown", {
      key: "2",
      bubbles: true,
      cancelable: true,
      composed: true,
      [modifier]: true,
    });
    group.dispatchEvent(event);
    await panel.updateComplete;
    expect([...props.model.drafts.get("format")!.selected]).toEqual(["Compact"]);
    expect(document.activeElement).toBe(group);
    expect(reached).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
    expect(composer.value).toBe("kept draft");
  },
);

it.each(["input", "textarea"])("preserves numeric text editing in a focused %s", async (tag) => {
  const { panel, group, composer, props } = await mountQuestion();
  const editor =
    tag === "textarea"
      ? panel.querySelector<HTMLTextAreaElement>("textarea")!
      : group.appendChild(document.createElement("input"));
  editor.value = "local answer";
  editor.focus();
  const event = new KeyboardEvent("keydown", {
    key: "2",
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  editor.dispatchEvent(event);
  await panel.updateComplete;
  expect(document.activeElement).toBe(editor);
  expect(event.defaultPrevented).toBe(false);
  expect([...props.model.drafts.get("format")!.selected]).toEqual(["Compact"]);
  expect(editor.value).toBe("local answer");
  expect(composer.value).toBe("kept draft");
});

it("leaves Space at an option button for native activation", async () => {
  const { panel, composer, props } = await mountQuestion();
  const option = panel.querySelector<HTMLButtonElement>("[data-option-index='1']")!;
  option.focus();
  const reached = vi.fn();
  option.addEventListener("keydown", reached);
  const event = new KeyboardEvent("keydown", {
    key: " ",
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  option.dispatchEvent(event);
  expect(document.activeElement).toBe(option);
  expect(reached).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(false);
  // jsdom does not synthesize the browser's default button activation.
  option.click();
  await panel.updateComplete;
  expect([...props.model.drafts.get("format")!.selected]).toEqual(["Detailed"]);
  expect(composer.value).toBe("kept draft");
});

it.each(["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"])(
  "retains radio navigation for %s",
  async (key) => {
    const { panel, composer, props } = await mountQuestion();
    const first = panel.querySelector<HTMLButtonElement>("[data-option-index='0']")!;
    first.focus();
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    first.dispatchEvent(event);
    await panel.updateComplete;
    expect([...props.model.drafts.get("format")!.selected]).toEqual(["Detailed"]);
    expect(document.activeElement).toBe(panel.querySelector("[data-option-index='1']"));
    expect(event.defaultPrevented).toBe(true);
    expect(composer.value).toBe("kept draft");
  },
);

it("retains Enter submission at the panel", async () => {
  const { group, composer, onSubmit } = await mountQuestion();
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  group.dispatchEvent(event);
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ format: ["Compact"] });
  expect(event.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(group);
  expect(composer.value).toBe("kept draft");
});

it.each(["disabled", "submitting"] as const)(
  "does not reserve disabled numeric choices or submit while %s",
  async (flag) => {
    const { panel, group, composer, props, onSubmit } = await mountQuestion();
    panel.props = { ...panel.props!, model: { ...panel.props!.model, [flag]: true } };
    await panel.updateComplete;
    expect(panel.querySelector<HTMLButtonElement>("[data-option-index='1']")!.disabled).toBe(true);
    expect(panel.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(true);
    group.dispatchEvent(
      new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true, composed: true }),
    );
    expect(document.activeElement).toBe(composer);
    group.focus();
    group.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
    expect([...props.model.drafts.get("format")!.selected]).toEqual(["Compact"]);
    expect(onSubmit).not.toHaveBeenCalled();
  },
);

it.each(["a", "A", "0", "9"])("keeps composer autotype for unadvertised key %s", async (key) => {
  const { group, composer, props } = await mountQuestion();
  const reached = vi.fn();
  group.addEventListener("keydown", reached);
  group.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true }),
  );
  expect(document.activeElement).toBe(composer);
  expect(reached).not.toHaveBeenCalled();
  expect([...props.model.drafts.get("format")!.selected]).toEqual(["Compact"]);
  expect(composer.value).toBe("kept draft");
});

it("does not let a question elsewhere claim a number from an unrelated control", async () => {
  const { root, composer, props } = await mountQuestion();
  const outside = root.appendChild(document.createElement("button"));
  outside.focus();
  outside.dispatchEvent(
    new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true, composed: true }),
  );
  expect(document.activeElement).toBe(composer);
  expect([...props.model.drafts.get("format")!.selected]).toEqual(["Compact"]);
});

it("preserves optional arrival while composing and removes shortcut ownership while collapsed", async () => {
  const { panel, composer, props } = await mountQuestion();
  composer.focus();
  panel.props = {
    ...props,
    model: { ...props.model, requestKey: "next-optional", collapsed: false },
  };
  await panel.updateComplete;
  expect(document.activeElement).toBe(composer);
  panel.querySelector<HTMLButtonElement>(".chat-question-panel__collapse")!.click();
  await panel.updateComplete;
  const collapsed = panel.querySelector<HTMLButtonElement>(
    ".chat-question-panel__collapsed-button",
  )!;
  collapsed.focus();
  collapsed.dispatchEvent(
    new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true, composed: true }),
  );
  expect(document.activeElement).toBe(composer);
  expect([...props.model.drafts.get("format")!.selected]).toEqual(["Compact"]);
});

it.each([false, true])("preserves existing disclosure ownership when open=%s", async (open) => {
  const { root, composer } = await mountQuestion();
  const details = root.appendChild(document.createElement("details"));
  details.open = open;
  details.setAttribute("data-chat-autotype-shortcuts", "");
  const summary = details.appendChild(document.createElement("summary"));
  summary.textContent = "Actions";
  const action = details.appendChild(document.createElement("button"));
  action.dataset.shortcut = "2";
  summary.focus();
  summary.dispatchEvent(
    new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true, composed: true }),
  );
  expect(document.activeElement).toBe(open ? summary : composer);
});

it("yields numeric ownership while a submit is pending", async () => {
  const { panel, group, composer, props } = await mountQuestion();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onSubmit = vi.fn(() => pending);
  panel.props = { ...panel.props!, onSubmit };
  await panel.updateComplete;
  panel.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.click();
  await panel.updateComplete;
  expect(onSubmit).toHaveBeenCalledOnce();
  expect(panel.querySelector<HTMLButtonElement>("[data-option-index='1']")!.disabled).toBe(true);
  group.focus();
  group.dispatchEvent(
    new KeyboardEvent("keydown", { key: "3", bubbles: true, cancelable: true, composed: true }),
  );
  expect(document.activeElement).toBe(composer);
  expect([...props.model.drafts.get("format")!.selected]).toEqual(["Compact"]);
  finish();
  await pending;
  await panel.updateComplete;
});

it("does not reserve undisplayed numeric keys beyond nine options", async () => {
  const { panel, group, composer, props } = await mountQuestion();
  const question = {
    ...props.model.questions[0]!,
    options: Array.from({ length: 10 }, (_, index) => ({ label: `Option ${index + 1}` })),
  };
  panel.props = { ...panel.props!, model: { ...panel.props!.model, questions: [question] } };
  await panel.updateComplete;
  group.dispatchEvent(
    new KeyboardEvent("keydown", { key: "9", bubbles: true, cancelable: true, composed: true }),
  );
  await panel.updateComplete;
  expect([...props.model.drafts.get("format")!.selected]).toEqual(["Option 9"]);
  group.focus();
  group.dispatchEvent(
    new KeyboardEvent("keydown", { key: "0", bubbles: true, cancelable: true, composed: true }),
  );
  expect(document.activeElement).toBe(composer);
  expect(panel.querySelector("[data-option-index='9']")!.hasAttribute("data-shortcut")).toBe(false);
  expect(panel.querySelector(".chat-question-panel__other")!.hasAttribute("data-shortcut")).toBe(
    false,
  );
});
