/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionGoalFixture } from "../../../../src/gateway/session-goal.test-support.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ChatGoalAction, ChatGoalDraftMode } from "../../lib/chat/chat-types.ts";
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
  "renders goal details and gates actions when connected=%s",
  async (connected) => {
    renderGoal({}, { connected });
    await waitForSolid(() => expect(goalPart("label")).not.toBeNull());
    const goal = container.querySelector(".agent-chat__goal");
    expect(goalPart("label")).toMatchObject({ textContent: "Pursuing goal" });
    expect(goalPart("objective")).toMatchObject({ textContent: objective });
    expect(goalPart("elapsed")).toMatchObject({ textContent: "15s" });
    expect(goal?.getAttribute("aria-label")).toBe("Pursuing goal (12k/50k): Land the web goal UI");
    expect(goal?.closest(".agent-chat__goal-float")).not.toBeNull();
    expect(goal?.closest(".agent-chat__composer-status-stack")).toBeNull();
    expect(button("Resume goal")).toBeNull();
    if (connected) {
      button("Pause goal")?.click();
      button("Clear goal")?.click();
      expect(onGoalAction).toHaveBeenNthCalledWith(1, "goal-1", "pause");
      expect(onGoalAction).toHaveBeenNthCalledWith(2, "goal-1", "clear");
    } else {
      expect(button("Pause goal")).toBeNull();
    }
    expect(goalPart("detail")?.getAttribute("aria-hidden")).toBe("true");
    const toggle = button("Show goal details");
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    toggle?.click();
    renderGoal({ lastStatusNote: "Waiting for CI" }, { connected });
    const detail = goalPart("detail");
    expect(detail?.getAttribute("aria-hidden")).toBe("false");
    expect(text("detail-objective")).toBe(objective);
    expect(text("detail-note")).toBe("Waiting for CI");
    expect(
      Array.from(goalPart("detail-meta")?.querySelectorAll(":scope > span") ?? [], (element) =>
        element.textContent?.trim(),
      ),
    ).toEqual(["12k/50k", "·", "15s"]);
    expect(button("Hide goal details")?.getAttribute("aria-expanded")).toBe("true");
  },
);

it("exposes the pause reason in a keyboard-accessible tooltip and freezes elapsed time", async () => {
  const now = Date.now();
  renderGoal({ createdAt: now - 60_000 });
  await waitForSolid(() => expect(goalPart("icon")).not.toBeNull());
  const runningIcon = goalPart("icon")?.innerHTML;

  renderGoal({
    createdAt: now - 60_000,
    status: "paused",
    pausedAt: now - 10_000,
    lastStatusNote: pauseReason,
  });

  const label = goalPart("label");
  expect(label?.textContent).toBe("Goal paused");
  expect(label?.getAttribute("tabindex")).toBe("0");
  expect(label?.closest("openclaw-tooltip")?.content).toBe(pauseReason);
  expect(text("detail-note")).toBe(pauseReason);
  expect(goalPart("icon")?.innerHTML).not.toBe(runningIcon);
  expect(goalPart("icon")?.getAttribute("aria-hidden")).toBe("true");
  expect(text("elapsed")).toBe("50s");
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
  button("Show goal details")!.click();

  renderChat({ selectedSession: undefined });
  expect(container.querySelector(".agent-chat__goal")).toBeNull();

  renderGoal({ status: "paused", lastStatusNote: "Ready to resume" });
  await waitForSolid(() => expect(button("Resume goal")).not.toBeNull());
  expect(goalPart("detail")?.getAttribute("aria-hidden")).toBe("false");
  button("Resume goal")!.click();
  expect(onGoalAction).toHaveBeenCalledExactlyOnceWith("goal-1", "resume");
});

it("edits the plain objective and restores the conversation draft on cancellation", async () => {
  let draft = "Keep my conversation draft";
  let goalDraftMode: ChatGoalDraftMode | null = null;
  const onDraftChange = vi.fn((next: string) => {
    draft = next;
  });
  const draw = () =>
    renderGoal(
      {},
      {
        draft,
        getDraft: () => draft,
        onGoalSubmit: vi.fn(async () => true),
        goalDraftMode,
        onGoalDraftModeChange: (mode) => {
          goalDraftMode = mode;
          draw();
        },
        onDraftChange,
      },
    );
  draw();
  await waitForSolid(() => expect(button("Edit goal")).not.toBeNull());

  button("Edit goal")?.click();

  expect(onDraftChange).toHaveBeenCalledWith(objective, undefined);
  await waitForSolid(() => expect(text("mode")).toContain("Edit goal"));
  button("Cancel goal entry")?.click();
  expect(draft).toBe("Keep my conversation draft");
  expect(goalPart("mode")).toBeNull();
});
