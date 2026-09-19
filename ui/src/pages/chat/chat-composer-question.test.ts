/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { t } from "../../i18n/index.ts";
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

  it("keeps every concurrent gateway question reachable", async () => {
    const container = document.createElement("div");
    const onRequestUpdate = vi.fn();
    const composerProps = props({
      sessionKey: "queue-test",
      gatewayQuestionPrompts: [
        questionPrompt("question-1", "First prompt"),
        questionPrompt("question-2", "Second prompt"),
      ],
      onRequestUpdate,
    });

    render(renderChatComposer(composerProps), container);
    let panel = container.querySelector("openclaw-chat-question-panel") as HTMLElement & {
      props: {
        model: { questions: Array<{ question: string }>; requestPosition?: unknown };
        onNextRequest?: () => void;
      };
    };
    expect(panel.props.model.questions[0]?.question).toBe("First prompt");
    expect(panel.props.model.requestPosition).toEqual({ current: 1, total: 2 });

    panel.props.onNextRequest?.();
    expect(onRequestUpdate).toHaveBeenCalledOnce();
    render(renderChatComposer(composerProps), container);
    panel = container.querySelector("openclaw-chat-question-panel") as typeof panel;
    expect(panel.props.model.questions[0]?.question).toBe("Second prompt");
    expect(panel.props.model.requestPosition).toEqual({ current: 2, total: 2 });
  });

  it("keeps unscoped and other-session gateway questions out of the composer", () => {
    const unscopedPrompt = questionPrompt("question-1", "Unscoped prompt");
    unscopedPrompt.sessionKey = undefined;
    const otherSessionPrompt = questionPrompt("question-2", "Other prompt");
    otherSessionPrompt.sessionKey = "agent:other:main";

    const view = renderComposer({
      sessionKey: "queue-test",
      gatewayQuestionPrompts: [unscopedPrompt, otherSessionPrompt],
    });

    expect(view.container.querySelector("openclaw-chat-question-panel")).toBeNull();
  });
  it("replaces the composer with the archived-session notice", () => {
    const onAction = vi.fn();
    const onAbort = vi.fn();
    const { container } = renderComposer({
      canSend: false,
      canAbort: true,
      onAbort,
      gatewayQuestionPrompts: [{ ...questionPrompt("pending", "Continue?"), sessionKey: "main" }],
      disabledBanner: {
        kind: "composer-replacement",
        text: "This session is archived. Unarchive it to continue the conversation.",
        actionLabel: "Unarchive",
        onAction,
      },
    });

    const banner = container.querySelector(".agent-chat__disabled-banner");
    expect(banner?.textContent).toContain("This session is archived.");
    expect(container.querySelector(".agent-chat__input")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("openclaw-chat-question-panel")).toBeNull();
    expect(container.querySelector(".agent-chat__typing-indicator--outside")).toBeNull();
    banner?.querySelector<HTMLButtonElement>("button")?.click();
    expect(onAction).toHaveBeenCalledOnce();
    const stop = container.querySelector<HTMLButtonElement>(
      `[aria-label="${t("chat.runControls.stopGenerating")}"]`,
    );
    expect(stop).not.toBeNull();
    stop?.click();
    expect(onAbort).toHaveBeenCalledOnce();
  });
});
