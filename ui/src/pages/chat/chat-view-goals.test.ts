/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => {
  installTranscriptDomMocks();
});

afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

function renderChatInto(
  container: HTMLElement,
  overrides: Partial<Parameters<typeof renderChat>[0]> = {},
) {
  render(
    renderChat(createChatProps({ currentSessionId: "goal-session", ...overrides })),
    container,
  );
}

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
        objective: "Land the web goal UI",
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
      const onGoalAction = vi.fn();
      const container = document.createElement("div");
      const props = {
        selectedSession: goalSession(),
        onGoalAction,
        connected,
      };
      renderChatInto(container, props);
      const goal = container.querySelector(".agent-chat__goal");
      expect(goal?.querySelector(".agent-chat__goal-label")?.textContent).toBe("Pursuing goal");
      expect(goal?.querySelector(".agent-chat__goal-objective")?.textContent).toBe(
        "Land the web goal UI",
      );
      expect(goal?.querySelector(".agent-chat__goal-elapsed")?.textContent).toBe("15s");
      expect(goal?.getAttribute("aria-label")).toBe(
        "Pursuing goal (12k/50k): Land the web goal UI",
      );
      expect(goal?.closest(".agent-chat__goal-float")).not.toBeNull();
      expect(goal?.closest(".agent-chat__composer-status-stack")).toBeNull();
      const button = (label: string) =>
        container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      expect(button("Resume goal")).toBeNull();
      if (connected) {
        button("Pause goal")?.click();
        button("Clear goal")?.click();
        expect(onGoalAction).toHaveBeenNthCalledWith(1, "goal-1", "pause");
        expect(onGoalAction).toHaveBeenNthCalledWith(2, "goal-1", "clear");
      } else {
        expect(button("Pause goal")).toBeNull();
      }
      expect(container.querySelector(".agent-chat__goal-detail")?.getAttribute("aria-hidden")).toBe(
        "true",
      );
      const toggle = button("Show goal details");
      expect(toggle).not.toBeNull();
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      toggle?.click();
      props.selectedSession = goalSession({ lastStatusNote: "Waiting for CI" });
      renderChatInto(container, props);
      const detail = container.querySelector(".agent-chat__goal-detail");
      expect(detail?.getAttribute("aria-hidden")).toBe("false");
      expect(detail?.querySelector(".agent-chat__goal-detail-objective")?.textContent).toBe(
        "Land the web goal UI",
      );
      expect(detail?.querySelector(".agent-chat__goal-detail-note")?.textContent).toBe(
        "Waiting for CI",
      );
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
    const container = document.createElement("div");
    const now = Date.now();
    const selectedSession = goalSession({ createdAt: now - 60_000 });
    const onGoalAction = vi.fn();
    renderChatInto(container, { selectedSession, onGoalAction });
    const runningIcon = container.querySelector(".agent-chat__goal-icon")?.innerHTML;

    const pausedSession = {
      ...selectedSession,
      goal: {
        ...selectedSession.goal!,
        status: "paused" as const,
        pausedAt: now - 10_000,
        lastStatusNote: "Paused after an error. Resume to continue.",
      },
    };
    renderChatInto(container, { selectedSession: pausedSession, onGoalAction });

    const goal = container.querySelector(".agent-chat__goal");
    expect(goal?.querySelector(".agent-chat__goal-label")?.textContent).toBe("Goal paused");
    const label = goal?.querySelector(".agent-chat__goal-label");
    expect(label?.getAttribute("tabindex")).toBe("0");
    expect(label?.closest("openclaw-tooltip")?.content).toBe(
      "Paused after an error. Resume to continue.",
    );
    expect(goal?.querySelector(".agent-chat__goal-detail-note")?.textContent).toBe(
      "Paused after an error. Resume to continue.",
    );
    expect(goal?.querySelector(".agent-chat__goal-icon")?.innerHTML).not.toBe(runningIcon);
    expect(goal?.querySelector(".agent-chat__goal-icon")?.getAttribute("aria-hidden")).toBe("true");
    expect(goal?.querySelector(".agent-chat__goal-elapsed")?.textContent).toBe("50s");
    expect(goal?.querySelector('button[aria-label="Pause goal"]')).toBeNull();
    goal?.querySelector<HTMLButtonElement>('button[aria-label="Resume goal"]')?.click();
    expect(onGoalAction).toHaveBeenCalledWith("goal-1", "resume");

    renderChatInto(container, {
      selectedSession: goalSession({ lastStatusNote: "Continuing after the pause" }),
      onGoalAction,
    });
    const runningLabel = container.querySelector(".agent-chat__goal-label");
    expect(runningLabel?.hasAttribute("tabindex")).toBe(false);
    expect(runningLabel?.closest("openclaw-tooltip")?.content).toBe("");
  });

  it("restores goal actions and expansion after a transient missing session goal", () => {
    const container = document.createElement("div");
    onTestFinished(() => render(null, container));
    const onGoalAction = vi.fn();
    const selectedSession = goalSession({ status: "paused", pausedAt: Date.now() });
    renderChatInto(container, { selectedSession, onGoalAction });
    container.querySelector<HTMLButtonElement>('button[aria-label="Show goal details"]')!.click();

    renderChatInto(container, { selectedSession: undefined, onGoalAction });
    expect(container.querySelector(".agent-chat__goal")).toBeNull();

    renderChatInto(container, {
      selectedSession: goalSession({ status: "paused", lastStatusNote: "Ready to resume" }),
      onGoalAction,
    });
    expect(container.querySelector(".agent-chat__goal-detail")?.getAttribute("aria-hidden")).toBe(
      "false",
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Resume goal"]')!.click();
    expect(onGoalAction).toHaveBeenCalledExactlyOnceWith("goal-1", "resume");
  });

  it("edits the plain objective and restores the conversation draft on cancellation", () => {
    let draft = "Keep my conversation draft";
    const container = document.createElement("div");
    const onDraftChange = vi.fn((next: string) => {
      draft = next;
    });
    const draw = () =>
      renderChatInto(container, {
        selectedSession: goalSession(),
        draft,
        getDraft: () => draft,
        onGoalAction: vi.fn(),
        onGoalSubmit: vi.fn(async () => true),
        onDraftChange,
        onRequestUpdate: draw,
      });
    draw();

    container.querySelector<HTMLButtonElement>('button[aria-label="Edit goal"]')?.click();

    expect(onDraftChange).toHaveBeenCalledWith("Land the web goal UI", undefined);
    expect(container.querySelector(".agent-chat__goal-mode")?.textContent).toContain("Edit goal");
    container.querySelector<HTMLButtonElement>('button[aria-label="Cancel goal entry"]')?.click();
    expect(draft).toBe("Keep my conversation draft");
    expect(container.querySelector(".agent-chat__goal-mode")).toBeNull();
  });
});
