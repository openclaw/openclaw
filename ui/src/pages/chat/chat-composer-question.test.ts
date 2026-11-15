/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createComposerQuestionPrompt as questionPrompt,
  createComposerControlsFixture,
  renderComposerFixture as renderComposer,
  resetComposerFixture,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
import { questionPanelIn } from "./components/chat-question-card.test-support.ts";

afterEach(() => resetComposerFixture());

it("keeps a child's question above the live draft, attachments, and IME without taking focus", async () => {
  const first = questionPrompt("child-first", "Choose a release target");
  const second = questionPrompt("child-second", "Choose a release format");
  first.sessionKey = second.sessionKey = "agent:main:dashboard:release-checks";
  first.agentId = second.agentId = "main";
  const skip = vi.fn();
  const { container, props: composerProps } = renderComposer({
    sessionKey: "agent:main:dashboard:parent",
    draft: "Keep this draft",
    attachments: [{ id: "notes", mimeType: "text/plain", fileName: "release-notes.txt" }],
    gatewayQuestionPrompts: [],
    gatewayQuestionSources: new Map([
      [first.id, "Release checks"],
      [second.id, "Release checks"],
    ]),
    onGatewayQuestionSkip: skip,
  });
  document.body.append(container);
  const draw = () => renderComposerInto(container, composerProps);
  await waitForSolid(() => expect(container.textContent).toContain("release-notes.txt"));
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  textarea.focus();
  textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  textarea.value = "Keep this draft 日本";
  textarea.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertCompositionText",
      isComposing: true,
    }),
  );
  composerProps.gatewayQuestionPrompts = [first, second];
  draw();
  let panel = await questionPanelIn(container);
  expect(container.querySelector(".agent-chat__composer-combobox textarea")).toBe(textarea);
  expect(document.activeElement).toBe(textarea);
  expect(textarea.value).toBe("Keep this draft 日本");
  expect(composerProps.draft).toBe("Keep this draft");
  expect(container.textContent).toContain("release-notes.txt");
  expect(container.querySelectorAll("openclaw-chat-question-panel")).toHaveLength(1);
  expect(panel.textContent).toContain("1/2");
  expect(panel.textContent).toContain("Waiting for your answer");
  const link = panel.querySelector<HTMLAnchorElement>(".chat-question-panel__source a")!;
  expect(link.textContent).toBe("Release checks");
  expect(link.dataset.sessionKey).toBe(first.sessionKey);
  expect(link.href).toContain("release-checks");
  panel.props!.onCollapsedChange!(true);
  draw();
  panel = await questionPanelIn(container);
  expect(first.status).toBe("pending");
  expect(skip).not.toHaveBeenCalled();
  expect(textarea.value).toBe("Keep this draft 日本");
  panel.props!.onNextRequest!();
  draw();
  panel = await questionPanelIn(container);
  expect(panel.textContent).toContain("Choose a release format");
  expect(container.querySelector(".agent-chat__composer-combobox textarea")).toBe(textarea);
  expect(document.activeElement).toBe(textarea);
  first.status = second.status = "answered";
  draw();
  await waitForSolid(() =>
    expect(container.querySelector("openclaw-chat-question-panel")).toBeNull(),
  );
  expect(document.activeElement).toBe(textarea);
  expect(textarea.value).toBe("Keep this draft 日本");
  textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  expect(composerProps.draft).toBe("Keep this draft 日本");
  expect(container.textContent).toContain("release-notes.txt");
  container.remove();
});

it.each([
  { progressOpen: true, takeover: "expand" },
  { progressOpen: false, takeover: "next" },
])(
  "restores the composer after $takeover (progress=$progressOpen)",
  async ({ progressOpen, takeover }) => {
    const prompt = questionPrompt("question-swap", "Choose a release target");
    const nextPrompt = questionPrompt("question-next", "Choose a release format");
    const { container, props: composerProps } = renderComposer({
      collapseTaskProgress: progressOpen,
      progressCard: { sessionKey: "queue-test", revision: 1, updatedAt: 1, markdown: "Progress" },
      sessionKey: "queue-test",
      draft: "Keep this draft",
      composerControls: createComposerControlsFixture(),
    });
    document.body.append(container);
    const draw = () => renderComposerInto(container, composerProps);
    const editor = () => container.querySelector<HTMLTextAreaElement>("textarea")!;
    const compose = (value: string) => {
      editor().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      editor().value = value;
      editor().dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertCompositionText" }),
      );
    };

    await vi.dynamicImportSettled();
    await waitForSolid(() =>
      expect(container.querySelector(".session-progress-card--composer")).not.toBeNull(),
    );
    const progress = container.querySelector<HTMLDetailsElement>(
      ".session-progress-card--composer",
    )!;
    progress.querySelector("summary")!.click();
    const progressWrapper = progress.closest<HTMLElement>(".agent-chat__progress-float")!;
    expect(progressWrapper.hidden).toBe(false);
    const expectRestored = (draft: string) => {
      expect(container.querySelector(".session-progress-card--composer")).toBe(progress);
      expect(progressWrapper.hidden).toBe(false);
      expect(progress.open).toBe(progressOpen);
      expect(editor().value).toBe(draft);
      expect(document.activeElement).toBe(editor());
    };
    const expectQuestion = (panel: Element, draft: string) => {
      expect(
        container.querySelector(
          ".agent-chat__input, .agent-chat__composer-footer, .agent-chat__typing-indicator--outside",
        ),
      ).toBeNull();
      expect(document.activeElement).toBe(panel.querySelector(".chat-question-panel"));
      expect(composerProps.draft).toBe(draft);
      expect(progressWrapper.hidden).toBe(true);
    };
    const initialTextarea = editor();
    initialTextarea.focus();
    expect(document.activeElement).toBe(initialTextarea);
    compose("Keep this draft while composing");

    composerProps.gatewayQuestionPrompts = [prompt, nextPrompt];
    draw();
    let panel = await questionPanelIn(container);
    expectQuestion(panel, "Keep this draft while composing");
    expect(progress.open).toBe(progressOpen);

    composerProps.draft = "Host updated this draft while the question was open";

    panel.props!.onCollapsedChange!(true);
    draw();
    await Promise.resolve();
    expectRestored("Host updated this draft while the question was open");

    const composedDraft = `Draft composed before ${takeover}`;
    compose(composedDraft);
    panel = await questionPanelIn(container);
    if (takeover === "expand") {
      panel.props!.onCollapsedChange!(false);
    } else {
      panel.props!.onNextRequest!();
    }
    draw();
    await questionPanelIn(container);
    expectQuestion(panel, composedDraft);
    prompt.status = "answered";
    nextPrompt.status = "answered";
    draw();
    await Promise.resolve();
    expectRestored(composedDraft);
    expect(container.querySelector("openclaw-chat-question-panel")).toBeNull();
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
