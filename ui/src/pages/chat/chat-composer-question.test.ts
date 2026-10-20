/* @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
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

it.each([true, false])(
  "restores the composer after question takeover (open=%s)",
  async (progressOpen) => {
    const container = document.body.appendChild(createComposerContainer());
    const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
      container.querySelector<T>(selector)!;
    const prompt = questionPrompt("question-swap", "Choose a release target");
    const composer = props({
      collapseTaskProgress: progressOpen,
      sessionKey: "queue-test",
      draft: "Keep this draft",
      gatewayQuestionPrompts: [],
      composerControls: createComposerControlsFixture(),
      progressCard: {
        sessionKey: "queue-test",
        revision: 1,
        updatedAt: Date.now(),
        markdown: "Release preparation",
        steps: [{ step: "Choose a target", status: "in_progress" }],
      },
    });
    const draw = () => renderComposerInto(container, composer);
    draw();
    const progress = q<HTMLDetailsElement>(".session-progress-card--composer");
    progress.querySelector("summary")!.click();
    const wrapper = progress.closest<HTMLElement>(".agent-chat__progress-float")!;
    const updatedDraft = "Host updated this draft while the question was open";
    const expectRestored = () => {
      const input = q<HTMLTextAreaElement>("textarea");
      expect(q(".session-progress-card--composer")).toBe(progress);
      expect(wrapper.hidden).toBe(false);
      expect(progress.open).toBe(progressOpen);
      expect(input.value).toBe(updatedDraft);
      expect(document.activeElement).toBe(input);
    };
    expect(progress.open).toBe(progressOpen);
    expect(wrapper.hidden).toBe(false);
    const input = q<HTMLTextAreaElement>("textarea");
    input.focus();
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "Keep this draft while composing";
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertCompositionText" }),
    );

    composer.gatewayQuestionPrompts = [prompt];
    draw();
    let panel = await questionPanelIn(container);
    expect(
      q(".agent-chat__input, .agent-chat__composer-footer, .agent-chat__typing-indicator--outside"),
    ).toBeNull();
    expect(document.activeElement).toBe(panel.querySelector(".chat-question-panel"));
    expect(composer.draft).toBe("Keep this draft while composing");
    expect(wrapper.hidden).toBe(true);
    expect(progress.open).toBe(progressOpen);
    composer.draft = updatedDraft;
    panel.props!.onCollapsedChange!(true);
    draw();
    await Promise.resolve();
    expectRestored();
    panel = await questionPanelIn(container);
    panel.props!.onCollapsedChange!(false);
    draw();
    await questionPanelIn(container);
    expect(q(".agent-chat__input")).toBeNull();
    expect(document.activeElement).toBe(panel.querySelector(".chat-question-panel"));
    expect(wrapper.hidden).toBe(true);
    prompt.status = "answered";
    draw();
    await Promise.resolve();
    expectRestored();
    expect(q("openclaw-chat-question-panel")).toBeNull();
  },
);

it("hides pending progress during question takeover", () => {
  const { container } = renderComposer({
    sessionKey: "queue-test",
    progressCardInitialLoading: true,
    gatewayQuestionPrompts: [questionPrompt("loading-progress", "Continue?")],
  });
  expect(container.querySelector(".agent-chat__progress-float--loading")).toMatchObject({
    hidden: true,
  });
  expect(container.querySelector(".agent-chat__input")).toBeNull();
});
