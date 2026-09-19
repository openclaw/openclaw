/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { createAsyncQuestionPresentation, type AsyncQuestionDraft } from "./chat-async-question.ts";

const container = document.createElement("div");
afterEach(() => {
  render(nothing, container);
  container.remove();
});

it.each(["answered", "failed"] as const)(
  "keeps a remounted async question locked until its original send is %s",
  async (outcome) => {
    document.body.append(container);
    const pending = createDeferred<boolean>();
    const submit = vi.fn(() => pending.promise);
    const state = {
      asyncQuestionDrafts: new Map<string, AsyncQuestionDraft>(),
      asyncQuestionRevision: 0,
      transcriptRenderContext: { onAsyncQuestionSubmit: submit },
    };
    const questions = {
      itemId: "question-1",
      questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
    };
    const draw = () => {
      render(
        html`<openclaw-chat-async-question
          .questions=${questions}
          .presentation=${createAsyncQuestionPresentation(state, {
            sessionKey: "agent:main:main",
            onAsyncQuestionSubmit: submit,
            onRequestUpdate: draw,
          })}
        ></openclaw-chat-async-question>`,
        container,
      );
    };
    draw();
    await vi.waitFor(() =>
      expect(container.querySelector(".chat-question-panel__advance")).not.toBeNull(),
    );
    container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.click();
    expect(submit).toHaveBeenCalledExactlyOnceWith("> Which audience?\n\nEngineers");

    render(nothing, container);
    draw();
    await vi.waitFor(() =>
      expect(container.querySelector(".chat-question-panel__advance")).not.toBeNull(),
    );
    expect(
      container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.disabled,
    ).toBe(true);
    expect(container.querySelector<HTMLButtonElement>(".chat-question-panel__skip")!.disabled).toBe(
      true,
    );

    if (outcome === "answered") {
      pending.resolve(true);
      await vi.waitFor(() =>
        expect(container.querySelector('[role="status"]')?.textContent).toContain("Engineers"),
      );
    } else {
      pending.reject(new Error("Synthetic send failure"));
      await vi.waitFor(() => expect(container.textContent).toContain("Synthetic send failure"));
      expect(
        container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.disabled,
      ).toBe(false);
    }
    expect(submit).toHaveBeenCalledTimes(1);
  },
);
