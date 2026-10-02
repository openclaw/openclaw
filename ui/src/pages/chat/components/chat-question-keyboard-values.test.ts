/* @vitest-environment jsdom */

import assert from "node:assert/strict";
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { renderComposerQuestionDock } from "./chat-composer-question.ts";
import { questionPanelIn } from "./chat-question-card.test-support.ts";
import type { QuestionPanelProps } from "./chat-question-card.ts";

afterEach(() => document.body.replaceChildren());

it.each(["2", "ArrowRight"])("submits the canonical option value selected with %s", async (key) => {
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
          presentation: "form",
          options: [
            { label: "Compact", value: "compact-id" },
            { label: "Detailed", value: "  detailed-id  " },
          ],
        },
      ],
      collapsed: false,
      disabled: false,
      drafts: new Map(),
    },
    onSubmit,
  };
  render(renderComposerQuestionDock(props), container);
  const panel = await questionPanelIn(container);
  const target = container.querySelector<HTMLElement>(
    key === "2" ? ".chat-question-panel" : '[role="radio"]',
  );
  assert(target);
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  await panel.updateComplete;
  expect(container.querySelectorAll('[role="radio"]')[1]?.getAttribute("aria-checked")).toBe(
    "true",
  );
  const submit = container.querySelector<HTMLButtonElement>(".chat-question-panel__advance");
  assert(submit);
  submit.click();
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ format: ["  detailed-id  "] });
});
