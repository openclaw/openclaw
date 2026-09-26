/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import {
  createComposerProps as props,
  renderComposerFixture as renderComposer,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { renderChatComposer } from "./components/chat-composer.ts";

function questionPrompt(id: string, question: string): QuestionPrompt {
  return {
    id,
    questions: [
      {
        questionId: "choice",
        header: "Choice",
        question,
        options: [{ label: "Yes" }, { label: "No" }],
        isOther: false,
      },
    ],
    sessionKey: "queue-test",
    createdAtMs: 1_000,
    expiresAtMs: Date.now() + 60_000,
    status: "pending",
    answeredElsewhere: false,
    localResolutionConfirmed: false,
    locallyExpired: false,
    submitting: false,
    error: null,
    drafts: new Map(),
    revision: 1,
  };
}

afterEach(() => resetComposerFixture());

describe("composer question takeover", () => {
  it.each([true, false])(
    "swaps the expanded question with the composer and restores its draft, focus, and progress (open=%s)",
    async (progressOpen) => {
      const container = document.createElement("div");
      document.body.append(container);
      const prompt = questionPrompt("question-swap", "Choose a release target");
      const composerProps = props({
        paneId: `question-swap-pane-${progressOpen}`,
        collapseTaskProgress: progressOpen,
        progressCard: {
          sessionKey: "queue-test",
          revision: 1,
          updatedAt: Date.now(),
          markdown: "Release preparation",
          steps: [{ step: "Choose a target", status: "in_progress" }],
        },
        sessionKey: "queue-test",
        draft: "Keep this draft",
        gatewayQuestionPrompts: [],
        composerControls: html`<button type="button">Model</button>`,
        onRequestUpdate: vi.fn(),
      });
      composerProps.onDraftChange = (next) => {
        composerProps.draft = next;
      };
      const draw = () => render(renderChatComposer(composerProps), container);

      draw();
      const progress = container.querySelector<HTMLDetailsElement>(
        ".session-progress-card--composer",
      )!;
      progress.querySelector("summary")!.click();
      expect(progress.open).toBe(progressOpen);
      const progressWrapper = progress.parentElement!;
      expect(progressWrapper.hidden).toBe(false);
      const initialTextarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
      initialTextarea.focus();
      expect(document.activeElement).toBe(initialTextarea);
      initialTextarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      initialTextarea.value = "Keep this draft while composing";
      initialTextarea.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertCompositionText" }),
      );

      composerProps.gatewayQuestionPrompts = [prompt];
      draw();
      let panel = container.querySelector("openclaw-chat-question-panel") as HTMLElement & {
        updateComplete: Promise<unknown>;
        props: { onCollapsedChange: (collapsed: boolean) => void };
      };
      await panel.updateComplete;
      expect(container.querySelector(".agent-chat__input")).toBeNull();
      expect(container.querySelector(".agent-chat__composer-footer")).toBeNull();
      expect(container.querySelector(".agent-chat__typing-indicator--outside")).toBeNull();
      expect(document.activeElement).toBe(panel.querySelector(".chat-question-panel"));
      expect(composerProps.draft).toBe("Keep this draft while composing");
      expect(progressWrapper.hidden).toBe(true);
      expect(progress.open).toBe(progressOpen);

      composerProps.draft = "Host updated this draft while the question was open";

      panel.props.onCollapsedChange(true);
      draw();
      await Promise.resolve();
      let textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
      expect(container.querySelector(".session-progress-card--composer")).toBe(progress);
      expect(progressWrapper.hidden).toBe(false);
      expect(progress.open).toBe(progressOpen);
      expect(textarea.value).toBe("Host updated this draft while the question was open");
      expect(document.activeElement).toBe(textarea);

      panel = container.querySelector("openclaw-chat-question-panel") as typeof panel;
      panel.props.onCollapsedChange(false);
      draw();
      await panel.updateComplete;
      expect(container.querySelector(".agent-chat__input")).toBeNull();
      expect(document.activeElement).toBe(panel.querySelector(".chat-question-panel"));

      expect(progressWrapper.hidden).toBe(true);
      prompt.status = "answered";
      draw();
      await Promise.resolve();
      textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
      expect(container.querySelector(".session-progress-card--composer")).toBe(progress);
      expect(progressWrapper.hidden).toBe(false);
      expect(progress.open).toBe(progressOpen);
      expect(textarea.value).toBe("Host updated this draft while the question was open");
      expect(document.activeElement).toBe(textarea);
      expect(container.querySelector("openclaw-chat-question-panel")).toBeNull();

      container.remove();
    },
  );

  it("hides the pending progress slot during question takeover", () => {
    const view = renderComposer({
      sessionKey: "queue-test",
      progressCardInitialLoading: true,
      gatewayQuestionPrompts: [questionPrompt("loading-progress", "Continue?")],
    });
    const slot = view.container.querySelector<HTMLElement>(".agent-chat__progress-float--loading")!;
    expect(slot.hidden).toBe(true);
    expect(view.container.querySelector(".agent-chat__input")).toBeNull();
  });
});
