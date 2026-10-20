/* @vitest-environment jsdom */

import assert from "node:assert/strict";
import { createComponent } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ComposerQuestionDock } from "./chat-composer-question.tsx";
import { questionPanelIn } from "./chat-question-card.test-support.ts";
import type { QuestionPanelProps } from "./chat-question-card.ts";

afterEach(() => document.body.replaceChildren());

const options = [
  { label: "Compact", value: "compact-id" },
  { label: "Detailed", value: "  detailed-id  " },
  ...Array.from({ length: 11 }, (_, index) => ({
    label: `Format ${index + 3}`,
    value: `format-${index + 3}`,
  })),
];

type Question = QuestionPanelProps["model"]["questions"][number];
const keydown = (target: HTMLElement, key: string, modifiers: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  target.dispatchEvent(event);
  return event;
};
const badges = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("kbd"), (badge) => badge.textContent?.trim());
function required(container: HTMLElement, selector: string) {
  const element = container.querySelector<HTMLElement>(selector);
  assert(element);
  return element;
}
async function mountQuestion(question: Partial<Question>) {
  const container = document.body.appendChild(document.createElement("div"));
  const onSubmit = vi.fn();
  const props: QuestionPanelProps = {
    model: {
      requestKey: "canonical-keyboard",
      title: "Choose a format",
      questions: [
        {
          questionId: "format",
          header: "Format",
          question: "Which format?",
          options: [],
          ...question,
        },
      ],
      collapsed: false,
      disabled: false,
      drafts: new Map(),
    },
    onSubmit,
  };
  mountSolid(() => createComponent(ComposerQuestionDock, { panel: props }), { container });
  const panel = await questionPanelIn(container);
  const group = required(container, ".chat-question-panel");
  return { container, panel, group, onSubmit };
}

it.each([
  { selector: ".chat-question-panel", modifier: "ctrlKey" },
  { selector: ".chat-question-panel", modifier: "metaKey" },
  { selector: '[role="radio"][aria-checked="true"]', modifier: "ctrlKey" },
  { selector: '[role="radio"][aria-checked="true"]', modifier: "metaKey" },
  { selector: '[role="checkbox"][aria-checked="true"]', modifier: "ctrlKey" },
  { selector: '[role="checkbox"][aria-checked="true"]', modifier: "metaKey" },
  { selector: "textarea", modifier: "ctrlKey" },
  { selector: "textarea", modifier: "metaKey" },
])(
  "submits selected answers from $selector with $modifier+Enter",
  async ({ selector, modifier }) => {
    const { container, panel, group, onSubmit } = await mountQuestion({
      options: options.slice(0, 2),
      multiSelect: selector.includes("checkbox"),
      isOther: true,
    });
    group.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    await panel.updateComplete;
    const target = required(container, selector);
    target.focus();
    const event = keydown(target, "Enter", { [modifier]: true });
    expect(event.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ format: ["  detailed-id  "] });
  },
);

it.each([
  { key: "2", value: "  detailed-id  " },
  { key: "5", value: "format-5" },
  { key: "9", value: "format-9" },
  { key: "ArrowRight", value: "  detailed-id  " },
])("submits the canonical option value selected with $key", async ({ key, value }) => {
  const { container, panel, group, onSubmit } = await mountQuestion({
    presentation: "form",
    options,
  });
  expect(badges(container)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  const target =
    key === "ArrowRight" ? container.querySelector<HTMLElement>('[role="radio"]') : group;
  assert(target);
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  await panel.updateComplete;
  required(container, ".chat-question-panel__advance").click();
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ format: [value] });
});

it.each([false, true])("respects allowEmpty=%s for shortcut submission", async (allowEmpty) => {
  const { group, onSubmit } = await mountQuestion({
    options: [],
    allowEmpty,
  });
  const event = keydown(group, "Enter", { ctrlKey: true });
  expect(event.defaultPrevented).toBe(allowEmpty);
  expect(onSubmit.mock.calls).toEqual(allowEmpty ? [[{ format: [] }]] : []);
});

it("keeps native activation on links, file pickers, and action buttons", async () => {
  const { container, onSubmit } = await mountQuestion({
    questionId: "attachment",
    header: "Attachment",
    question: "Attach a file",
    options: [],
    allowEmpty: true,
    url: "https://example.test/confirm",
    resource: { viewId: "synthetic-form", selection: "implicit", userOptions: { kind: "file" } },
  });
  for (const selector of [
    "a",
    "input[type=file]",
    ".chat-question-panel__collapse",
    ".chat-question-panel__advance",
  ]) {
    const target = required(container, selector);
    target.focus();
    for (const keys of [{}, { ctrlKey: true }, { metaKey: true }]) {
      const event = keydown(target, "Enter", keys);
      expect(event.defaultPrevented, selector).toBe(false);
      expect(onSubmit).not.toHaveBeenCalled();
    }
  }
});

it("numbers only visible implicit resources and cannot restore a hidden option with a shortcut", async () => {
  const { container, panel, group, onSubmit } = await mountQuestion({
    questionId: "resources",
    header: "Resources",
    question: "Keep resources",
    presentation: "form",
    multiSelect: true,
    allowEmpty: true,
    defaultAnswers: ["kept"],
    resource: { viewId: "synthetic-form", selection: "implicit", userOptions: { kind: "file" } },
    options: [
      { label: "Hidden", value: "hidden", resourceUri: "parts://hidden" },
      { label: "Kept", value: "kept", resourceUri: "parts://kept" },
    ],
  });
  expect(badges(container)).toEqual(["1"]);
  group.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
  await panel.updateComplete;
  expect(container.querySelector(".chat-question-panel__option")).toBeNull();
  for (const key of ["1", "2"]) {
    const event = keydown(group, key);
    expect(event.defaultPrevented).toBe(false);
  }
  group.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ resources: [] });
});

it.each([8, 9])(
  "offers an Other shortcut only within the nine-key range (%d options)",
  async (count) => {
    const { container, panel, group } = await mountQuestion({
      isOther: true,
      options: options.slice(0, count),
    });
    expect(
      container.querySelector(".chat-question-panel__option--other kbd")?.textContent?.trim(),
    ).toBe(count === 8 ? "9" : undefined);
    group.dispatchEvent(new KeyboardEvent("keydown", { key: "9", bubbles: true }));
    await panel.updateComplete;
    if (count === 8) {
      expect(document.activeElement).toBe(container.querySelector("textarea"));
    } else {
      expect(container.querySelector('[aria-checked="true"]')?.textContent).toContain("Format 9");
    }
  },
);
