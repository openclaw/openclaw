/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionGoal } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { ChatGoal, clearGoalElapsedTimers } from "./components/chat-composer-goal.tsx";
import { resetChatComposerState } from "./components/chat-composer-state.ts";

const goal: SessionGoal = {
  schemaVersion: 1,
  id: "goal-timing",
  objective: "Verify the deployment",
  status: "active",
  createdAt: 1_000,
  updatedAt: 61_000,
  tokenStart: 0,
  tokensUsed: 100,
  continuationTurns: 0,
};

function mountGoal(initial: SessionGoal) {
  const [readGoal, setGoal] = createSignal<SessionGoal | undefined>(initial, { equals: false });
  const view = mountSolid(() => (
    <ChatGoal goal={readGoal()} expanded={false} canAct={false} onExpandedChange={() => {}} />
  ));
  flush();
  return {
    container: view.container,
    draw: (value: SessionGoal | undefined) => {
      setGoal(() => value);
      flush();
    },
    unmount: view.unmount,
    elapsed: () => view.container.querySelector(".agent-chat__goal-elapsed")?.textContent,
  };
}

describe("goal elapsed presentation", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    vi.useFakeTimers();
    vi.setSystemTime(121_000);
  });

  afterEach(() => {
    clearGoalElapsedTimers();
    resetChatComposerState();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it.each([
    ["active", "2m 00s"],
    ["paused", "1m 00s"],
    ["blocked", "1m 00s"],
    ["usage_limited", "1m 00s"],
    ["budget_limited", "1m 00s"],
    ["complete", "1m 00s"],
  ] as const)("renders elapsed time immediately for %s goals", (status, elapsed) => {
    const view = mountGoal({ ...goal, status });
    expect(view.elapsed()).toBe(elapsed);
  });

  it("replaces a live tick with the authoritative stop time and resumes ticking", () => {
    const view = mountGoal(goal);
    vi.advanceTimersByTime(1_000);
    expect(view.elapsed()).toBe("2m 01s");

    view.draw({ ...goal, status: "paused", pausedAt: 46_000 });
    expect(view.elapsed()).toBe("45s");
    vi.advanceTimersByTime(60_000);
    expect(view.elapsed()).toBe("45s");

    view.draw(goal);
    expect(view.elapsed()).toBe("3m 01s");
    vi.advanceTimersByTime(60_000);
    expect(view.elapsed()).toBe("4m 01s");

    view.draw({ ...goal, status: "complete", completedAt: 151_000 });
    expect(view.elapsed()).toBe("2m 30s");
    vi.advanceTimersByTime(60_000);
    expect(view.elapsed()).toBe("2m 30s");
  });

  it("retires the active timer when the goal is removed", () => {
    const view = mountGoal(goal);
    expect(vi.getTimerCount()).toBe(1);
    view.draw(undefined);
    expect(view.container.querySelector(".agent-chat__goal")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires the active timer on unmount and resumes from the current time on remount", () => {
    let view = mountGoal(goal);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    view = mountGoal(goal);
    expect(view.elapsed()).toBe("3m 00s");
    expect(vi.getTimerCount()).toBe(1);
  });
});
