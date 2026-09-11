/* @vitest-environment jsdom */

// Composer status-region behavior: gateway question panels, interrupted-run
// status, and compaction overlays that swap with or float above the composer.
import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  createComposerProps as props,
  questionPrompt,
  renderComposerFixture as renderComposer,
} from "./chat-composer.test-support.ts";
import { renderChatComposer } from "./components/chat-composer.ts";

describe("renderChatComposer status", () => {
  it("swaps the expanded question with the composer and restores its draft and focus", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const prompt = questionPrompt("question-swap", "Choose a release target");
    const composerProps = props({
      paneId: "question-swap-pane",
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

    composerProps.draft = "Host updated this draft while the question was open";

    panel.props.onCollapsedChange(true);
    draw();
    await Promise.resolve();
    let textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.value).toBe("Host updated this draft while the question was open");
    expect(document.activeElement).toBe(textarea);

    panel = container.querySelector("openclaw-chat-question-panel") as typeof panel;
    panel.props.onCollapsedChange(false);
    draw();
    await panel.updateComplete;
    expect(container.querySelector(".agent-chat__input")).toBeNull();
    expect(document.activeElement).toBe(panel.querySelector(".chat-question-panel"));

    prompt.status = "answered";
    draw();
    await Promise.resolve();
    textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.value).toBe("Host updated this draft while the question was open");
    expect(document.activeElement).toBe(textarea);
    expect(container.querySelector("openclaw-chat-question-panel")).toBeNull();

    container.remove();
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
  it("floats a fresh interrupted status above the composer", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let view = renderComposer({
      runStatus: { phase: "done", runId: "run-0", sessionKey: "main", occurredAt: 900 },
    });
    expect(view.container.querySelector(".agent-chat__run-status")).toBeNull();

    view = renderComposer({
      runStatus: { phase: "interrupted", runId: "run-1", sessionKey: "main", occurredAt: 900 },
      composerControls: html`<button type="button">Settings</button>`,
    });
    const interrupted = view.container.querySelector(".agent-chat__run-status--interrupted");
    expect(interrupted).not.toBeNull();
    expect(interrupted?.closest(".agent-chat__composer-run-status")).not.toBeNull();
    expect(interrupted?.querySelector("rect")?.getAttribute("width")).toBe("18");
    expect(
      view.container.querySelector(".agent-chat__run-status-announcement")?.textContent,
    ).toContain("Interrupted");

    now.mockReturnValue(7_000);
    view = renderComposer({
      runStatus: { phase: "interrupted", runId: "run-1", sessionKey: "main", occurredAt: 1_000 },
      composerControls: html`<button type="button">Settings</button>`,
    });
    expect(view.container.querySelector(".agent-chat__run-status--interrupted")).toBeNull();
  });

  it("keeps fallback status in the composer without a compaction overlay", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { container } = renderComposer({
      fallbackStatus: {
        selected: "fireworks/minimax-m2p5",
        active: "deepinfra/moonshotai/Kimi-K2.5",
        attempts: ["fireworks/minimax-m2p5: rate limit"],
        occurredAt: 900,
      },
    });
    expect(container.querySelector(".compaction-indicator--active")).toBeNull();
    expect(container.querySelector(".chat-compaction")).toBeNull();
    expect(container.querySelector(".compaction-indicator--fallback")?.textContent?.trim()).toBe(
      "Fallback active: deepinfra/moonshotai/Kimi-K2.5",
    );
    expect(
      container.querySelector(".compaction-indicator--fallback")?.getAttribute("aria-label"),
    ).toBe(
      "Selected: fireworks/minimax-m2p5 • Active: deepinfra/moonshotai/Kimi-K2.5 • Attempts: fireworks/minimax-m2p5: rate limit",
    );
  });
});
