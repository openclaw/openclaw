/* @vitest-environment jsdom */

// Regression for the goal-pill elapsed race (U-V6): the elapsed timer used to write
// element.textContent directly on the node Lit tracks as the ${elapsed} ChildPart,
// which raced Lit commits into "ChildPart has no parentNode" and silently corrupted
// later composer renders (approval cards never appeared). The owner's repro: an active
// session goal plus a plan checklist that updates a few times, after which a
// plan-approval swap-in must still render.

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GatewaySessionRow,
  SessionGoal,
  SessionPlanState,
  SessionsListResult,
} from "../../api/types.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { renderChatComposer, resetChatComposerState } from "./components/chat-composer.ts";
import { resetPlanChecklistStoreForTest, setPlanChecklist } from "./plan-stream-store.ts";

vi.mock("../../components/icons.ts", () => ({
  icons: {},
}));

vi.mock("../../components/markdown.ts", () => ({
  toSanitizedMarkdownHtml: (value: string) => value,
}));

type ComposerProps = Parameters<typeof renderChatComposer>[0];

const SESSION_KEY = "main";
const PANE_ID = "pane-goal-race";

function activeGoal(): SessionGoal {
  return {
    schemaVersion: 1,
    id: "goal-1",
    objective: "Ship the parity UI",
    status: "active",
    createdAt: 0,
    updatedAt: 0,
    tokenStart: 0,
    tokensUsed: 1_000,
    continuationTurns: 0,
  };
}

function sessionsWith(row: Partial<GatewaySessionRow>): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: 200_000 },
    sessions: [{ key: SESSION_KEY, kind: "direct", updatedAt: 0, ...row }],
  };
}

function createProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    paneId: PANE_ID,
    sessionKey: SESSION_KEY,
    currentAgentId: "main",
    connected: true,
    canSend: true,
    disabledReason: null,
    sending: false,
    messages: [],
    stream: null,
    queue: [] as ChatQueueItem[],
    draft: "",
    sessions: sessionsWith({ goal: activeGoal() }),
    assistantName: "OpenClaw",
    onDraftChange: () => undefined,
    onSend: () => undefined,
    onQueueRemove: () => undefined,
    onNewSession: () => undefined,
    onGoalCommand: () => undefined,
    ...overrides,
  };
}

describe("composer goal-pill elapsed race (U-V6)", () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    resetChatComposerState();
    resetPlanChecklistStoreForTest();
  });

  afterEach(() => {
    resetChatComposerState();
    resetPlanChecklistStoreForTest();
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps rendering through elapsed ticks and shows a later plan-approval swap-in", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    let props = createProps();
    // The host re-renders on requestUpdate — exactly how the elapsed tick now stays live.
    props = createProps({ onRequestUpdate: () => render(renderChatComposer(props), container) });

    render(renderChatComposer(props), container);
    expect(container.querySelector(".agent-chat__goal")).not.toBeNull();

    // Active goal + a plan checklist updating a few times over a few seconds.
    for (let update = 1; update <= 3; update += 1) {
      setPlanChecklist(SESSION_KEY, {
        explanation: "Working the plan",
        steps: [
          { step: "Read the spec", status: update >= 1 ? "completed" : "pending" },
          { step: "Write the code", status: update >= 2 ? "in_progress" : "pending" },
          { step: "Run the gate", status: update >= 3 ? "in_progress" : "pending" },
        ],
      });
      // Elapsed interval fires (host re-render), then the checklist update re-renders.
      vi.advanceTimersByTime(1_000);
      render(renderChatComposer(props), container);
    }

    // A later plan-approval swap-in must still render — the corruption used to eat it.
    const planPending: SessionPlanState = {
      schemaVersion: 1,
      status: "pending_approval",
      enteredAt: 0,
      updatedAt: 0,
      lastSummary: "Implement the parity UI",
    };
    props = createProps({
      sessions: sessionsWith({ goal: activeGoal(), plan: planPending }),
      onRequestUpdate: () => render(renderChatComposer(props), container),
    });
    render(renderChatComposer(props), container);

    // The plan-approval swap-in is the inline card; its content renders on updateComplete.
    const approvalCard = container.querySelector("openclaw-inline-plan-approval");
    expect(approvalCard).not.toBeNull();
    await (approvalCard as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
    expect(approvalCard!.querySelector('[data-plan-approve="true"]')).not.toBeNull();
    expect(approvalCard!.querySelector('[data-plan-revise="true"]')).not.toBeNull();

    const childPartErrors = errorSpy.mock.calls.filter((call) =>
      call.some(
        (arg) =>
          typeof arg === "string" && (arg.includes("ChildPart") || arg.includes("parentNode")),
      ),
    );
    expect(childPartErrors).toEqual([]);
  });

  it("stops the elapsed tick once the goal is no longer active", () => {
    const requestUpdate = vi.fn();
    let props = createProps({ onRequestUpdate: requestUpdate });
    render(renderChatComposer(props), container);

    vi.advanceTimersByTime(1_000);
    expect(requestUpdate).toHaveBeenCalledTimes(1);

    // Goal completes → the tick must clear itself on the next render.
    props = createProps({
      sessions: sessionsWith({ goal: { ...activeGoal(), status: "complete", completedAt: 5 } }),
      onRequestUpdate: requestUpdate,
    });
    render(renderChatComposer(props), container);

    const callsAfterComplete = requestUpdate.mock.calls.length;
    vi.advanceTimersByTime(3_000);
    expect(requestUpdate.mock.calls.length).toBe(callsAfterComplete);
  });
});
