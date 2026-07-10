/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionCardAnswers, QuestionCardEntry } from "../app/question-card.ts";
import { t } from "../i18n/index.ts";
import type { InlineQuestionCard } from "./inline-question-card.ts";
import "./inline-question-card.ts";

let container: HTMLDivElement;

const TWO_QUESTIONS: QuestionCardEntry = {
  id: "card-1",
  sessionKey: "main",
  turnSourceChannel: null,
  createdAtMs: 0,
  questions: [
    {
      id: "q1",
      header: "Deploy target",
      question: "Where should this ship?",
      isOther: true,
      isSecret: false,
      options: [{ label: "Production" }, { label: "Staging", description: "safer" }],
    },
    {
      id: "q2",
      header: "Notify",
      question: "Announce the release?",
      isOther: true,
      isSecret: false,
      options: [{ label: "Yes" }, { label: "No" }],
    },
  ],
};

async function renderCard(
  entry: QuestionCardEntry,
  handlers: {
    onSubmit?: (id: string, answers: QuestionCardAnswers) => void;
    onDismiss?: () => void;
    busy?: boolean;
    error?: string | null;
  } = {},
): Promise<InlineQuestionCard> {
  render(
    html`
      <openclaw-inline-question
        .props=${{
          entry,
          busy: handlers.busy ?? false,
          error: handlers.error ?? null,
          onSubmit: handlers.onSubmit ?? (() => undefined),
          onDismiss: handlers.onDismiss ?? (() => undefined),
        }}
      ></openclaw-inline-question>
    `,
    container,
  );
  const card = container.querySelector("openclaw-inline-question") as InlineQuestionCard;
  await card.updateComplete;
  return card;
}

describe("openclaw-inline-question", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders numbered options, the recommended chip, and the inline other label", async () => {
    await renderCard(TWO_QUESTIONS);
    const labels = [...container.querySelectorAll(".question-card-option-label")].map((node) =>
      node.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(labels[0]).toContain("1. Production");
    expect(labels[0]).toContain(t("question.recommended"));
    expect(labels[1]).toContain("2. Staging");
    expect(labels.at(-1)).toBe(t("question.otherInlineLabel"));
  });

  it("pages between questions while preserving selections", async () => {
    const card = await renderCard(TWO_QUESTIONS);
    expect(container.querySelector(".inline-question__page-indicator")?.textContent?.trim()).toBe(
      t("question.pageIndicator", { current: "1", total: "2" }),
    );

    const firstOption = container.querySelector<HTMLInputElement>(".question-card-option input");
    firstOption!.checked = true;
    firstOption!.dispatchEvent(new Event("change"));
    await card.updateComplete;

    container.querySelector<HTMLButtonElement>(`[aria-label="${t("question.next")}"]`)!.click();
    await card.updateComplete;
    expect(container.querySelector(".question-card-prompt")?.textContent).toContain(
      "Announce the release?",
    );

    // Back to the first question — the earlier selection is still checked.
    container.querySelector<HTMLButtonElement>(`[aria-label="${t("question.previous")}"]`)!.click();
    await card.updateComplete;
    expect(container.querySelector<HTMLInputElement>(".question-card-option input")!.checked).toBe(
      true,
    );
  });

  it("submits answers keyed by question id once every question is answered", async () => {
    const onSubmit = vi.fn();
    const card = await renderCard(TWO_QUESTIONS, { onSubmit });

    const submit = () =>
      container.querySelector<HTMLButtonElement>(".inline-question__actions .primary")!;
    expect(submit().disabled).toBe(true);

    // Answer q1 (option 0), page to q2, answer q2 (option 1).
    const q1First = container.querySelector<HTMLInputElement>(".question-card-option input");
    q1First!.checked = true;
    q1First!.dispatchEvent(new Event("change"));
    await card.updateComplete;
    expect(submit().disabled).toBe(true);

    container.querySelector<HTMLButtonElement>(`[aria-label="${t("question.next")}"]`)!.click();
    await card.updateComplete;
    const q2Options = container.querySelectorAll<HTMLInputElement>(".question-card-option input");
    q2Options[1]!.checked = true;
    q2Options[1]!.dispatchEvent(new Event("change"));
    await card.updateComplete;

    expect(submit().disabled).toBe(false);
    submit().click();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("card-1", {
      q1: { text: "Production" },
      q2: { text: "No" },
    });
  });

  it("dismisses via the Dismiss button and Escape", async () => {
    const onDismiss = vi.fn();
    const card = await renderCard(TWO_QUESTIONS, { onDismiss });

    container
      .querySelector<HTMLButtonElement>(`.inline-question__actions .btn:not(.primary)`)!
      .click();
    expect(onDismiss).toHaveBeenCalledTimes(1);

    card
      .querySelector(".inline-question")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
