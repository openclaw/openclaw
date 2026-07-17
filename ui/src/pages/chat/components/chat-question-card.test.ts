/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { renderChatQuestionCard } from "./chat-question-card.ts";

type ChatQuestionCardElement = HTMLElement & {
  updateComplete: Promise<unknown>;
};

function gatewayPrompt(overrides: Partial<QuestionPrompt> = {}): QuestionPrompt {
  return {
    id: "question-1",
    questions: [
      {
        id: "format",
        header: "Format",
        question: "Which format should I use?",
        options: [
          { label: "Compact", description: "Keep it brief" },
          { label: "Detailed", description: "Include rationale" },
        ],
        isOther: true,
      },
    ],
    sessionKey: "agent:main:main",
    createdAtMs: 1_000,
    expiresAtMs: 62_000,
    status: "pending",
    answeredElsewhere: false,
    localResolutionConfirmed: false,
    locallyExpired: false,
    submitting: false,
    error: null,
    drafts: new Map(),
    revision: 1,
    ...overrides,
  };
}

async function cardIn(container: HTMLElement): Promise<ChatQuestionCardElement> {
  const card = container.querySelector("openclaw-chat-question") as ChatQuestionCardElement;
  await card.updateComplete;
  return card;
}

describe("shared question card", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  describe("gateway adapter", () => {
    async function draw(
      prompt: QuestionPrompt,
      onSubmit: (answers: Record<string, string[]>) => void | Promise<void> = vi.fn(),
    ) {
      const redraw = () => {
        render(
          renderChatQuestionCard(prompt, {
            nowMs: 2_000,
            onChange: redraw,
            onSubmit,
          }),
          container,
        );
      };
      redraw();
      await cardIn(container);
      return onSubmit;
    }

    it("submits multiselect options and free text as arrays", async () => {
      const prompt = gatewayPrompt({
        questions: [
          {
            id: "extras",
            header: "Extras",
            question: "Which extras should I include?",
            options: [{ label: "Tests" }, { label: "Docs" }],
            multiSelect: true,
            isOther: true,
          },
          {
            id: "target",
            header: "Target",
            question: "Where should I send it?",
            options: [{ label: "Chat" }, { label: "File" }],
            isOther: true,
          },
        ],
      });
      const onSubmit = await draw(prompt);
      const card = await cardIn(container);
      const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      checkboxes[0]?.click();
      checkboxes[1]?.click();
      const targetInput = container.querySelectorAll<HTMLInputElement>(".chat-question__other")[1]!;
      targetInput.value = "Issue comment";
      targetInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await card.updateComplete;

      container.querySelector<HTMLButtonElement>(".chat-question__submit")?.click();

      expect(onSubmit).toHaveBeenCalledWith({
        extras: ["Tests", "Docs"],
        target: ["Issue comment"],
      });
    });

    it("renders countdown and answered-elsewhere state", async () => {
      const prompt = gatewayPrompt();
      await draw(prompt);
      expect(container.querySelector(".chat-question__countdown")?.textContent).toBe("1:00");

      prompt.status = "answered";
      prompt.answeredElsewhere = true;
      prompt.answers = { answers: { format: { answers: ["Detailed"] } } };
      await draw(prompt);

      expect(container.querySelector(".chat-question__status")?.textContent).toBe(
        "Answered elsewhere",
      );
      expect(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]?.checked).toBe(
        true,
      );
      expect(container.querySelector<HTMLInputElement>('input[type="radio"]')?.disabled).toBe(true);
    });

    it.each([
      ["expired", "Expired"],
      ["cancelled", "Cancelled"],
    ] as const)("renders %s terminal state", async (status, label) => {
      await draw(gatewayPrompt({ status }));

      expect(container.querySelector(".chat-question__status")?.textContent).toBe(label);
      expect(container.querySelector(".chat-question__submit")).toBeNull();
    });

    it("shows resolve errors while leaving another attempt enabled", async () => {
      const prompt = gatewayPrompt({ error: "gateway unavailable" });
      await draw(prompt);

      expect(container.querySelector(".chat-question__error")?.textContent).toContain(
        "gateway unavailable",
      );
      expect(container.querySelector<HTMLButtonElement>(".chat-question__submit")?.disabled).toBe(
        true,
      );
      container.querySelector<HTMLInputElement>('input[type="radio"]')?.click();
      await cardIn(container);
      expect(container.querySelector<HTMLButtonElement>(".chat-question__submit")?.disabled).toBe(
        false,
      );
    });

    it("clears the private submitted latch after a handled gateway rejection", async () => {
      const prompt = gatewayPrompt();
      await draw(prompt, async () => {
        prompt.error = "gateway unavailable";
      });
      const card = await cardIn(container);
      container.querySelector<HTMLInputElement>('input[type="radio"]')?.click();
      await card.updateComplete;

      container.querySelector<HTMLButtonElement>(".chat-question__submit")?.click();

      await vi.waitFor(() =>
        expect(container.querySelector<HTMLButtonElement>(".chat-question__submit")?.disabled).toBe(
          false,
        ),
      );
    });
  });
});
