/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createComponent } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ComposerQuestionDock } from "./chat-composer-question.tsx";
import { questionPanelIn } from "./chat-question-card.test-support.ts";
import type { QuestionPanelProps } from "./chat-question-card.ts";

const options = [
  { label: "Compact", value: "compact-id" },
  { label: "Detailed", value: "  detailed-id  " },
  ...Array.from({ length: 11 }, (_, index) => ({
    label: `Format ${index + 3}`,
    value: `format-${index + 3}`,
  })),
];

type Question = QuestionPanelProps["model"]["questions"][number];
const keydown = (target: HTMLElement, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};
const badges = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("kbd"), (badge) => badge.textContent?.trim());
const required = (container: HTMLElement, selector: string) =>
  expectDefined(container.querySelector<HTMLElement>(selector), selector);
async function mountQuestion(question: Partial<Question>) {
  const onSubmit = vi.fn();
  const prompt = { questionId: "format", header: "Format", question: "Format?", options: [] };
  const props: QuestionPanelProps = {
    model: {
      requestKey: "canonical-keyboard",
      title: "Choose a format",
      questions: [{ ...prompt, ...question }],
      collapsed: false,
      disabled: false,
      drafts: new Map(),
    },
    onSubmit,
  };
  const { container } = mountSolid(() => createComponent(ComposerQuestionDock, { panel: props }));
  const panel = await questionPanelIn(container);
  const group = required(container, ".chat-question-panel");
  const press = async (key: string, target = group) => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await panel.updateComplete;
  };
  return { container, group, onSubmit, press };
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
])("submits from $selector with $modifier+Enter", async ({ selector, modifier }) => {
  const { container, press, onSubmit } = await mountQuestion({
    options: options.slice(0, 2),
    multiSelect: selector.includes("checkbox"),
    isOther: true,
  });
  await press("2");
  const target = required(container, selector);
  target.focus();
  const event = keydown(target, "Enter", { [modifier]: true });
  expect(event.defaultPrevented).toBe(true);
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ format: ["  detailed-id  "] });
});

it.each([
  { key: "2", value: "  detailed-id  " },
  { key: "5", value: "format-5" },
  { key: "9", value: "format-9" },
  { key: "ArrowRight", value: "  detailed-id  " },
])("submits the canonical option value selected with $key", async ({ key, value }) => {
  const { container, press, group, onSubmit } = await mountQuestion({
    presentation: "form",
    options,
  });
  expect(badges(container)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  await press(key, key === "ArrowRight" ? required(container, '[role="radio"]') : group);
  required(container, ".chat-question-panel__advance").click();
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ format: [value] });
});

it.each([false, true])("respects allowEmpty=%s for shortcut submission", async (allowEmpty) => {
  const { group, onSubmit } = await mountQuestion({ allowEmpty });
  const event = keydown(group, "Enter", { ctrlKey: true });
  expect(event.defaultPrevented).toBe(allowEmpty);
  expect(onSubmit.mock.calls).toEqual(allowEmpty ? [[{ format: [] }]] : []);
});

it("keeps native activation on links, file pickers, and action buttons", async () => {
  const { container, onSubmit } = await mountQuestion({
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
      expect(keydown(target, "Enter", keys).defaultPrevented, selector).toBe(false);
      expect(onSubmit).not.toHaveBeenCalled();
    }
  }
});

it("numbers visible resources without restoring hidden options through shortcuts", async () => {
  const { container, press, group, onSubmit } = await mountQuestion({
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
  await press("1");
  expect(container.querySelector(".chat-question-panel__option")).toBeNull();
  for (const key of ["1", "2"]) {
    expect(keydown(group, key).defaultPrevented).toBe(false);
  }
  group.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ format: [] });
});

it.each([8, 9])("limits Other shortcuts to nine keys (%d options)", async (count) => {
  const { container, press } = await mountQuestion({
    isOther: true,
    options: options.slice(0, count),
  });
  const badge = container.querySelector(".chat-question-panel__option--other kbd");
  expect(badge?.textContent?.trim()).toBe(count === 8 ? "9" : undefined);
  await press("9");
  if (count === 8) {
    expect(document.activeElement).toBe(container.querySelector("textarea"));
  } else {
    expect(container.querySelector('[aria-checked="true"]')?.textContent).toContain("Format 9");
  }
});
