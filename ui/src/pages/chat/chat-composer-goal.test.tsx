/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionGoal } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { ChatGoal } from "./components/chat-composer-goal.tsx";

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

type GoalProps = Parameters<typeof ChatGoal>[0];
function mountGoal(initial: SessionGoal, options: Partial<GoalProps> = {}) {
  const [props, setProps] = createSignal<GoalProps>({
    goal: initial,
    expanded: false,
    canAct: false,
    onExpandedChange: () => {},
    ...options,
  });
  const view = mountSolid(() => <ChatGoal {...props()} />);
  const update = (value: Partial<GoalProps>) => {
    setProps((current) => ({ ...current, ...value }));
    flush();
  };
  flush();
  // The scroll affordance settles its frame before clock-lifecycle assertions.
  vi.advanceTimersToNextFrame();
  flush();
  return {
    container: view.container,
    draw: (value: SessionGoal | undefined) => update({ goal: value }),
    update,
    query: view.container.querySelector.bind(view.container),
    unmount: view.unmount,
    elapsed: () => view.container.querySelector(".agent-chat__goal-elapsed")?.textContent,
  };
}

function advanceTime(milliseconds: number) {
  vi.advanceTimersByTime(milliseconds);
  flush();
}

beforeEach(async () => {
  await i18n.setLocale("en");
  vi.useFakeTimers();
  vi.setSystemTime(121_000);
});

afterEach(() => vi.useRealTimers());

it.each([
  ["pause", "Pause not confirmed", "Pausing goal…", "Retry pause"],
  ["resume", "Resume not confirmed", "Resuming goal…", "Retry resume"],
  ["edit", "Edit not confirmed", "Saving goal…", "Retry save"],
  ["clear", "Removal not confirmed", "Removing goal…", "Retry removal"],
] as const)(
  "keeps the %s recovery decision with its goal",
  (action, title, pending, retryLabel) => {
    const onCheck = vi.fn(async () => true);
    const view = mountGoal(
      { ...goal, status: "paused", lastStatusNote: "Previous pause" },
      {
        expanded: true,
        connected: true,
        recovery: { action, pending: true, onCheck },
      },
    );
    const { query } = view;
    expect(query('[role="status"]')).toMatchObject({ textContent: pending });
    expect(query('[aria-busy="true"]')).not.toBeNull();
    expect(query(".session-run-spinner")).not.toBeNull();
    expect(view.container.textContent).not.toContain("Previous pause");
    view.update({ recovery: { action, pending: false, onCheck } });
    expect(query('[role="status"]')).toMatchObject({ textContent: title });
    const retry = query<HTMLButtonElement>(".agent-chat__goal-recovery-detail button")!;
    expect(retry.textContent).toBe(retryLabel);
    expect(query(".agent-chat__goal-command-actions")?.textContent).toBe("");
    retry.click();
    expect(onCheck).toHaveBeenCalledOnce();
    view.update({ connected: false });
    expect(retry.disabled).toBe(true);
    expect(query(".session-run-spinner")).toBeNull();
  },
);

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
  advanceTime(1_000);
  expect(view.elapsed()).toBe("2m 01s");

  const transitions: [SessionGoal, string, string][] = [
    [{ ...goal, status: "paused", pausedAt: 46_000 }, "45s", "45s"],
    [goal, "3m 01s", "4m 01s"],
    [{ ...goal, status: "complete", completedAt: 151_000 }, "2m 30s", "2m 30s"],
  ];
  for (const [next, immediate, afterMinute] of transitions) {
    view.draw(next);
    expect(view.elapsed()).toBe(immediate);
    advanceTime(60_000);
    expect(view.elapsed()).toBe(afterMinute);
  }
});

it.each(["remove", "unmount"])(
  "retires the timer on %s and starts a fresh clock on remount",
  (action) => {
    let view = mountGoal(goal);
    expect(vi.getTimerCount()).toBe(1);
    if (action === "remove") {
      view.draw(undefined);
    } else {
      view.unmount();
    }
    expect(view.container.querySelector(".agent-chat__goal")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    advanceTime(60_000);
    view = mountGoal(goal);
    expect(view.elapsed()).toBe("3m 00s");
    expect(vi.getTimerCount()).toBe(1);
  },
);
