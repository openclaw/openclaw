/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./chat-question-card.ts";

type ChatQuestionCardElement = HTMLElement & {
  updateComplete: Promise<unknown>;
};

describe("native Codex question card", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("submits a selected native option through the chat reply seam", async () => {
    const onSubmit = vi.fn();
    render(
      html`<openclaw-chat-question
        .props=${{
          disabled: false,
          onSubmit,
          status: {
            itemId: "item-1",
            actionToken: "test-action-token",
            questions: [
              {
                id: "mode",
                header: "Mode",
                question: "Pick one",
                isOther: false,
                options: [{ label: "Fast" }, { label: " Deep ", description: "More reasoning" }],
              },
            ],
          },
        }}
      ></openclaw-chat-question>`,
      container,
    );
    const card = container.querySelector("openclaw-chat-question") as ChatQuestionCardElement;
    await card.updateComplete;
    const options = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    options[1]!.click();
    await card.updateComplete;
    container.querySelector<HTMLButtonElement>(".chat-question__submit")!.click();
    expect(onSubmit).toHaveBeenCalledWith({ mode: " Deep " }, expect.any(Function));
    await card.updateComplete;
    expect(container.querySelector<HTMLButtonElement>(".chat-question__submit")?.disabled).toBe(
      true,
    );
  });

  it("renders a free-form answer field", async () => {
    render(
      html`<openclaw-chat-question
        .props=${{
          disabled: false,
          onSubmit: vi.fn(),
          status: {
            itemId: "item-other",
            actionToken: "test-action-token",
            questions: [
              {
                id: "other",
                header: "Alternative",
                question: "Type another answer",
                isOther: true,
                options: [],
              },
            ],
          },
        }}
      ></openclaw-chat-question>`,
      container,
    );
    const card = container.querySelector("openclaw-chat-question") as ChatQuestionCardElement;
    await card.updateComplete;
    expect(container.querySelector<HTMLInputElement>(".chat-question__other")?.type).toBe("text");
  });

  it("re-enables submission when the scoped command is rejected", async () => {
    let reject: (() => void) | undefined;
    render(
      html`<openclaw-chat-question
        .props=${{
          disabled: false,
          onSubmit: (_answers: Record<string, string>, onRejected: () => void) => {
            reject = onRejected;
          },
          status: {
            itemId: "item-retry",
            actionToken: "test-action-token",
            questions: [
              {
                id: "mode",
                header: "Mode",
                question: "Pick one",
                isOther: false,
                options: [{ label: "Retry" }],
              },
            ],
          },
        }}
      ></openclaw-chat-question>`,
      container,
    );
    const card = container.querySelector("openclaw-chat-question") as ChatQuestionCardElement;
    await card.updateComplete;
    container.querySelector<HTMLInputElement>('input[type="radio"]')!.click();
    await card.updateComplete;
    const submit = container.querySelector<HTMLButtonElement>(".chat-question__submit")!;
    submit.click();
    await card.updateComplete;
    expect(submit.disabled).toBe(true);

    reject?.();
    await card.updateComplete;
    expect(submit.disabled).toBe(false);
  });

  it("clears free-form text when the request token changes", async () => {
    const question = {
      id: "other",
      header: "Alternative",
      question: "Type another answer",
      isOther: true,
      options: [] as Array<{ label: string }>,
    };
    const props = (actionToken: string) => ({
      disabled: false,
      onSubmit: vi.fn(),
      status: { itemId: "reused-item", actionToken, questions: [question] },
    });
    render(
      html`<openclaw-chat-question .props=${props("first-token")}></openclaw-chat-question>`,
      container,
    );
    const card = container.querySelector("openclaw-chat-question") as ChatQuestionCardElement;
    await card.updateComplete;
    const input = container.querySelector<HTMLInputElement>(".chat-question__other")!;
    input.value = "stale answer";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await card.updateComplete;
    expect(input.value).toBe("stale answer");

    render(
      html`<openclaw-chat-question .props=${props("second-token")}></openclaw-chat-question>`,
      container,
    );
    await card.updateComplete;
    expect(container.querySelector<HTMLInputElement>(".chat-question__other")?.value).toBe("");
  });

  it("preserves free-form text that begins with an option label", async () => {
    render(
      html`<openclaw-chat-question
        .props=${{
          disabled: false,
          onSubmit: vi.fn(),
          status: {
            itemId: "item-prefix",
            actionToken: "test-action-token",
            questions: [
              {
                id: "reason",
                header: "Decision",
                question: "Continue?",
                isOther: true,
                options: [{ label: "No" }],
              },
            ],
          },
        }}
      ></openclaw-chat-question>`,
      container,
    );
    const card = container.querySelector("openclaw-chat-question") as ChatQuestionCardElement;
    await card.updateComplete;
    const input = container.querySelector<HTMLInputElement>(".chat-question__other")!;
    input.value = "No";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await card.updateComplete;
    input.value = "No, because the proof failed";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await card.updateComplete;

    expect(input.value).toBe("No, because the proof failed");
  });
});
