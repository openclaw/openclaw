/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ChatGoalDraftMode } from "../../lib/chat/chat-types.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import {
  disposeChatView,
  renderChatInto as renderNativeChatInto,
} from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

let container: HTMLElement;
let onGoalAction: ReturnType<typeof vi.fn>;
beforeEach(() => {
  installTranscriptDomMocks();
  container = createComposerContainer();
  onGoalAction = vi.fn();
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

describe("chat goal status", () => {
  function goalSession(
    goal: Partial<NonNullable<GatewaySessionRow["goal"]>> = {},
  ): GatewaySessionRow {
    return {
      key: "main",
      sessionId: "goal-session",
      kind: "direct",
      updatedAt: 2,
      goal: {
        schemaVersion: 1,
        id: "goal-1",
        objective,
        status: "active",
        createdAt: Date.now() - 15_000,
        updatedAt: 2,
        tokenStart: 100,
        tokensUsed: 12_400,
        tokenBudget: 50_000,
        continuationTurns: 0,
        ...goal,
      },
    };
  }

  it.each([true, false])(
    "renders goal details and gates actions when connected=%s",
    (connected) => {
      const props = { selectedSession: goalSession(), connected };
      renderChat(props);
      const goal = container.querySelector(".agent-chat__goal");
      expect([text("label"), text("objective"), text("elapsed")]).toEqual([
        "Pursuing goal",
        objective,
        "15s",
      ]);
      expect(goal?.getAttribute("aria-label")).toBe(
        "Pursuing goal (12k/50k): Land the web goal UI",
      );
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
      props.selectedSession = goalSession({ lastStatusNote: "Waiting for CI" });
      renderChat(props);
      const detail = goalPart("detail");
      expect(detail?.getAttribute("aria-hidden")).toBe("false");
      expect(text("detail-objective")).toBe(objective);
      expect(text("detail-note")).toBe("Waiting for CI");
      expect(
        Array.from(
          detail?.querySelectorAll(".agent-chat__goal-detail-meta > span") ?? [],
          (element) => element.textContent?.trim(),
        ),
      ).toEqual(["12k/50k", "·", "15s"]);
      expect(button("Hide goal details")?.getAttribute("aria-expanded")).toBe("true");
    },
  );

  it("exposes the pause reason in a keyboard-accessible tooltip and freezes elapsed time", () => {
    const now = Date.now();
    const selectedSession = goalSession({ createdAt: now - 60_000 });
    renderChat({ selectedSession });
    const runningIcon = goalPart("icon")?.innerHTML;

    const pausedSession = {
      ...selectedSession,
      goal: {
        ...selectedSession.goal!,
        status: "paused" as const,
        pausedAt: now - 10_000,
        lastStatusNote: pauseReason,
      },
    };
    renderChat({ selectedSession: pausedSession });

    expect(text("label")).toBe("Goal paused");
    const label = goalPart("label");
    expect(label?.getAttribute("tabindex")).toBe("0");
    expect(label?.closest("openclaw-tooltip")?.content).toBe(pauseReason);
    expect(text("detail-note")).toBe(pauseReason);
    expect(goalPart("icon")?.innerHTML).not.toBe(runningIcon);
    expect(goalPart("icon")?.getAttribute("aria-hidden")).toBe("true");
    expect(text("elapsed")).toBe("50s");
    expect(button("Pause goal")).toBeNull();
    button("Resume goal")?.click();
    expect(onGoalAction).toHaveBeenCalledWith("goal-1", "resume");

    renderChat({
      selectedSession: goalSession({ lastStatusNote: "Continuing after the pause" }),
    });
    const runningLabel = goalPart("label");
    expect(runningLabel?.hasAttribute("tabindex")).toBe(false);
    expect(runningLabel?.closest("openclaw-tooltip")?.content).toBe("");
  });

  it("restores goal actions and expansion after a transient missing session goal", () => {
    onTestFinished(() => disposeChatView(container));
    const selectedSession = goalSession({ status: "paused", pausedAt: Date.now() });
    renderChat({ selectedSession });
    button("Show goal details")!.click();

    renderChat({ selectedSession: undefined });
    expect(container.querySelector(".agent-chat__goal")).toBeNull();

    renderChat({
      selectedSession: goalSession({ status: "paused", lastStatusNote: "Ready to resume" }),
    });
    expect(goalPart("detail")?.getAttribute("aria-hidden")).toBe("false");
    button("Resume goal")!.click();
    expect(onGoalAction).toHaveBeenCalledExactlyOnceWith("goal-1", "resume");
  });

  it("edits the plain objective and restores the conversation draft on cancellation", () => {
    let draft = "Keep my conversation draft";
    let goalDraftMode: ChatGoalDraftMode | null = null;
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const draw = () =>
      renderChat({
        selectedSession: goalSession(),
        draft,
        getDraft: () => draft,
        onGoalSubmit: vi.fn(async () => true),
        goalDraftMode,
        onGoalDraftModeChange: (mode) => {
          goalDraftMode = mode;
          draw();
        },
        onDraftChange,
      });
    draw();

    button("Edit goal")?.click();

    expect(onDraftChange).toHaveBeenCalledWith(objective, undefined);
    expect(text("mode")).toContain("Edit goal");
    button("Cancel goal entry")?.click();
    expect(draft).toBe("Keep my conversation draft");
    expect(goalPart("mode")).toBeNull();
  });
});
