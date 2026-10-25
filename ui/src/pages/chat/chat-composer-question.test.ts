/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerQuestionPrompt as questionPrompt,
  createComposerControlsFixture,
  createComposerProps as props,
  renderComposerFixture as renderComposer,
  resetComposerFixture,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
import { questionPanelIn } from "./components/chat-question-card.test-support.ts";

afterEach(() => resetComposerFixture());

describe("composer question takeover", () => {
  it.each([
    { progressOpen: true, takeover: "expand" },
    { progressOpen: false, takeover: "next" },
  ])(
    "restores draft, focus, and progress after $takeover takeover (open=$progressOpen)",
    async ({ progressOpen, takeover }) => {
      const container = createComposerContainer();
      document.body.append(container);
      const prompt = questionPrompt("question-swap", "Choose a release target");
      const nextPrompt = questionPrompt("question-next", "Choose a release format");
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
        composerControls: createComposerControlsFixture(),
      });
      composerProps.onDraftChange = (next) => {
        composerProps.draft = next;
      };
      const draw = () => renderComposerInto(container, composerProps);

      draw();
      await vi.dynamicImportSettled();
      await waitForSolid(() =>
        expect(container.querySelector(".session-progress-card--composer")).not.toBeNull(),
      );
      const progress = container.querySelector<HTMLDetailsElement>(
        ".session-progress-card--composer",
      )!;
      progress.querySelector("summary")!.click();
      expect(progress.open).toBe(progressOpen);
      const progressWrapper = progress.closest<HTMLElement>(".agent-chat__progress-float")!;
      expect(progressWrapper.hidden).toBe(false);
      const initialTextarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
      initialTextarea.focus();
      expect(document.activeElement).toBe(initialTextarea);
      initialTextarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      initialTextarea.value = "Keep this draft while composing";
      initialTextarea.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertCompositionText" }),
      );

      composerProps.gatewayQuestionPrompts = [prompt, nextPrompt];
      draw();
      let panel = await questionPanelIn(container);
      expect(container.querySelector(".agent-chat__input")).toBeNull();
      expect(container.querySelector(".agent-chat__composer-footer")).toBeNull();
      expect(container.querySelector(".agent-chat__typing-indicator--outside")).toBeNull();
      expect(document.activeElement).toBe(panel.querySelector(".chat-question-panel"));
      expect(composerProps.draft).toBe("Keep this draft while composing");
      expect(progressWrapper.hidden).toBe(true);
      expect(progress.open).toBe(progressOpen);

      composerProps.draft = "Host updated this draft while the question was open";

      panel.props!.onCollapsedChange!(true);
      draw();
      await Promise.resolve();
      let textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
      expect(container.querySelector(".session-progress-card--composer")).toBe(progress);
      expect(progressWrapper.hidden).toBe(false);
      expect(progress.open).toBe(progressOpen);
      expect(textarea.value).toBe("Host updated this draft while the question was open");
      expect(document.activeElement).toBe(textarea);

      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const composedDraft = `Draft composed before ${takeover}`;
      textarea.value = composedDraft;
      textarea.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertCompositionText" }),
      );
      panel = await questionPanelIn(container);
      if (takeover === "expand") {
        panel.props!.onCollapsedChange!(false);
      } else {
        panel.props!.onNextRequest!();
      }
      draw();
      await questionPanelIn(container);
      expect(container.querySelector(".agent-chat__input")).toBeNull();
      expect(document.activeElement).toBe(panel.querySelector(".chat-question-panel"));
      expect(composerProps.draft).toBe(composedDraft);

      expect(progressWrapper.hidden).toBe(true);
      prompt.status = "answered";
      nextPrompt.status = "answered";
      draw();
      await Promise.resolve();
      textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
      expect(container.querySelector(".session-progress-card--composer")).toBe(progress);
      expect(progressWrapper.hidden).toBe(false);
      expect(progress.open).toBe(progressOpen);
      expect(textarea.value).toBe(composedDraft);
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
