/* @vitest-environment jsdom */

// U-V3: the bulky inline plan-panel shrinks to a compact status chip in the
// composer status-stack; the full plan docks in the right sidebar pane.

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionPlanState, SessionsListResult } from "../../api/types.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { renderChatComposer, resetChatComposerState } from "./components/chat-composer.ts";
import { resetPlanChecklistStoreForTest, setPlanChecklist } from "./plan-stream-store.ts";

type ComposerProps = Parameters<typeof renderChatComposer>[0];

const SESSION_KEY = "main";

const PLAN: SessionPlanState = {
  schemaVersion: 1,
  status: "planning",
  enteredAt: 0,
  updatedAt: 0,
};

function sessions(plan: SessionPlanState | null): SessionsListResult {
  const row: GatewaySessionRow = {
    key: SESSION_KEY,
    kind: "direct",
    updatedAt: 0,
    ...(plan ? { plan } : {}),
  };
  return {
    ts: 0,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: 200_000 },
    sessions: [row],
  };
}

function createProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    paneId: "pane-plan",
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
    sessions: sessions(PLAN),
    assistantName: "OpenClaw",
    onDraftChange: () => undefined,
    onSend: () => undefined,
    onQueueRemove: () => undefined,
    onNewSession: () => undefined,
    ...overrides,
  };
}

describe("composer compact plan chip (U-V3)", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    resetChatComposerState();
    resetPlanChecklistStoreForTest();
  });

  afterEach(() => {
    resetChatComposerState();
    resetPlanChecklistStoreForTest();
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders a compact chip (not the full inline panel) with progress and opens the pane", () => {
    setPlanChecklist(SESSION_KEY, {
      steps: [
        { step: "one", status: "completed" },
        { step: "two", status: "in_progress" },
        { step: "three", status: "pending" },
      ],
    });
    const onViewPlan = vi.fn();
    render(renderChatComposer(createProps({ onViewPlan })), container);

    const chip = container.querySelector<HTMLButtonElement>("[data-plan-chip-compact]");
    expect(chip).not.toBeNull();
    // The bulky inline plan-panel no longer lives in the stack.
    expect(container.querySelector("[data-plan-panel]")).toBeNull();
    expect(chip!.textContent).toContain("1/3 done");

    chip!.click();
    expect(onViewPlan).toHaveBeenCalledTimes(1);
  });

  it("renders no plan chip when the session has no plan", () => {
    render(renderChatComposer(createProps({ sessions: sessions(null) })), container);
    expect(container.querySelector("[data-plan-chip-compact]")).toBeNull();
  });
});
