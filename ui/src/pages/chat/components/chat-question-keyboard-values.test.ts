/* @vitest-environment jsdom */

import assert from "node:assert/strict";
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { renderComposerQuestionDock } from "./chat-composer-question.tsx";
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

async function mountQuestion(question: QuestionPanelProps["model"]["questions"][number]) {
  const container = document.body.appendChild(document.createElement("div"));
  const onSubmit = vi.fn();
  const props: QuestionPanelProps = {
    model: {
      requestKey: "canonical-keyboard",
      title: "Choose a format",
      questions: [question],
      collapsed: false,
      disabled: false,
      drafts: new Map(),
    },
    onSubmit,
  };
  render(renderComposerQuestionDock(props), container);
  const panel = await questionPanelIn(container);
  const group = container.querySelector<HTMLElement>(".chat-question-panel");
  assert(group);
  return { container, panel, group, onSubmit };
}

it.each([
  { key: "2", value: "  detailed-id  " },
  { key: "5", value: "format-5" },
  { key: "9", value: "format-9" },
  { key: "ArrowRight", value: "  detailed-id  " },
])("submits the canonical option value selected with $key", async ({ key, value }) => {
  const { container, panel, group, onSubmit } = await mountQuestion({
    questionId: "format",
    header: "Format",
    question: "Which format?",
    presentation: "form",
    options,
  });
  expect(
    Array.from(container.querySelectorAll("kbd"), (badge) => badge.textContent?.trim()),
  ).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  const target =
    key === "ArrowRight" ? container.querySelector<HTMLElement>('[role="radio"]') : group;
  assert(target);
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  await panel.updateComplete;
  const submit = container.querySelector<HTMLButtonElement>(".chat-question-panel__advance");
  assert(submit);
  submit.click();
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ format: [value] });
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
  expect(
    Array.from(container.querySelectorAll("kbd"), (badge) => badge.textContent?.trim()),
  ).toEqual(["1"]);
  group.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
  await panel.updateComplete;
  expect(container.querySelector(".chat-question-panel__option")).toBeNull();
  for (const key of ["1", "2"]) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    group.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  group.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ resources: [] });
});

it.each([8, 9])(
  "offers an Other shortcut only within the nine-key range (%d options)",
  async (count) => {
    const { container, panel, group } = await mountQuestion({
      questionId: "format",
      header: "Format",
      question: "Which format?",
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
