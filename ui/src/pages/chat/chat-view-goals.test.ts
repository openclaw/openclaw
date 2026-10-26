/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionGoalFixture } from "../../../../src/gateway/session-goal.test-support.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ChatGoalAction } from "../../lib/chat/chat-types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { renderChatInto as renderNativeChatInto } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

let container: HTMLElement;
let onGoalAction = vi.fn<(goalId: string, action: ChatGoalAction) => void>();
beforeEach(() => {
  installTranscriptDomMocks();
  // Import latency must not advance the elapsed-time display under test.
  vi.spyOn(Date, "now").mockReturnValue(Date.now());
  container = createComposerContainer();
  onGoalAction = vi.fn<(goalId: string, action: ChatGoalAction) => void>();
});

afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

function renderChat(overrides: Parameters<typeof renderNativeChatInto>[1] = {}) {
  renderNativeChatInto(container, { currentSessionId: "goal-session", onGoalAction, ...overrides });
}

const objective = "Land the web goal UI";
const pauseReason = "Paused after an error. Resume to continue.";
const goalPart = (part: string) => container.querySelector(`.agent-chat__goal-${part}`);
const text = (part: string) => goalPart(part)?.textContent;
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

type Goal = Partial<NonNullable<GatewaySessionRow["goal"]>>;
function renderGoal(goal: Goal = {}, props: Parameters<typeof renderChat>[0] = {}) {
  const selectedSession: GatewaySessionRow = {
    key: "main",
    sessionId: "goal-session",
    kind: "direct",
    updatedAt: 2,
    goal: createSessionGoalFixture("goal-1", objective, {
      createdAt: Date.now() - 15_000,
      updatedAt: 2,
      tokenStart: 100,
      tokensUsed: 12_400,
      tokenBudget: 50_000,
      ...goal,
    }),
  };
  renderChat({ ...props, selectedSession });
}

it.each([true, false])(
  "keeps the floating goal actions scoped to connection state (%s)",
  async (connected) => {
    renderGoal({}, { connected });
    await waitForSolid(() => expect(goalPart("label")).not.toBeNull());
    const goal = container.querySelector(".agent-chat__goal");
    expect(goal?.getAttribute("aria-label")).toBe("Pursuing goal (12k/50k): Land the web goal UI");
    expect(goal?.closest(".agent-chat__goal-float")).not.toBeNull();
    expect(goal?.closest(".agent-chat__composer-status-stack")).toBeNull();
    expect(button("Resume goal")).toBeNull();
    if (connected) {
      button("Pause goal")?.click();
      button("Clear goal")?.click();
      expect(onGoalAction.mock.calls).toEqual([
        ["goal-1", "pause"],
        ["goal-1", "clear"],
      ]);
    } else {
      expect(button("Pause goal")).toBeNull();
    }
  },
);

it("exposes the pause reason in a keyboard-accessible tooltip and clears it on resume", async () => {
  const now = Date.now();
  renderGoal({
    createdAt: now - 60_000,
    status: "paused",
    pausedAt: now - 10_000,
    lastStatusNote: pauseReason,
  });
  await waitForSolid(() => expect(goalPart("label")).not.toBeNull());

  const label = goalPart("label");
  expect(label?.textContent).toBe("Goal paused");
  expect(label?.getAttribute("tabindex")).toBe("0");
  expect(label?.closest("openclaw-tooltip")?.content).toBe(pauseReason);
  expect(text("detail-note")).toBe(pauseReason);
  expect(goalPart("icon")?.getAttribute("aria-hidden")).toBe("true");
  expect(button("Pause goal")).toBeNull();
  button("Resume goal")?.click();
  expect(onGoalAction).toHaveBeenCalledWith("goal-1", "resume");

  renderGoal({ lastStatusNote: "Continuing after the pause" });
  const runningLabel = goalPart("label");
  expect(runningLabel?.hasAttribute("tabindex")).toBe(false);
  expect(runningLabel?.closest("openclaw-tooltip")?.content).toBe("");
});

it("restores goal actions and expansion after a transient missing session goal", async () => {
  renderGoal({ status: "paused", pausedAt: Date.now() });
  await waitForSolid(() => expect(button("Show goal details")).not.toBeNull());
  expect(button("Show goal details")?.getAttribute("aria-expanded")).toBe("false");
  expect(goalPart("detail")?.getAttribute("aria-hidden")).toBe("true");
  button("Show goal details")!.click();

  renderChat({ selectedSession: undefined });
  expect(container.querySelector(".agent-chat__goal")).toBeNull();

  renderGoal({ status: "paused", lastStatusNote: "Ready to resume" });
  await waitForSolid(() => expect(button("Resume goal")).not.toBeNull());
  expect(goalPart("detail")?.getAttribute("aria-hidden")).toBe("false");
  expect(button("Hide goal details")?.getAttribute("aria-expanded")).toBe("true");
  expect(text("detail-objective")).toBe(objective);
  expect(text("detail-note")).toBe("Ready to resume");
  expect(text("detail-meta")).toContain("12k/50k");
  button("Resume goal")!.click();
  expect(onGoalAction).toHaveBeenCalledExactlyOnceWith("goal-1", "resume");
});

it("opens the current plain objective for editing", async () => {
  const onDraftChange = vi.fn();
  const onGoalDraftModeChange = vi.fn();
  const draft = "Keep my conversation draft";
  renderGoal(
    {},
    { draft, onGoalSubmit: vi.fn(async () => true), onDraftChange, onGoalDraftModeChange },
  );
  await waitForSolid(() => expect(button("Edit goal")).not.toBeNull());
  button("Edit goal")?.click();
  expect(onDraftChange).toHaveBeenCalledWith(objective, undefined);
  expect(onGoalDraftModeChange).toHaveBeenCalledWith({
    action: "edit",
    goalId: "goal-1",
    previousDraft: draft,
  });
});
