/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionGoalFixture } from "../../../../src/gateway/session-goal.test-support.js";
import type { SessionGoal } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { ChatGoal } from "./components/chat-composer-goal.tsx";

const goal: SessionGoal = createSessionGoalFixture("goal-timing", "Verify the deployment", {
  createdAt: 1_000,
  updatedAt: 61_000,
  tokensUsed: 100,
});

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
    ...view,
    draw: (value: SessionGoal | undefined) => update({ goal: value }),
    update,
    query: view.container.querySelector.bind(view.container),
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

it("keeps Resume progress and its saved retry in the goal pill", () => {
  const onCheck = vi.fn(async () => true);
  const view = mountGoal(
    { ...goal, status: "paused", lastStatusNote: "Previous pause" },
    {
      expanded: true,
      connected: true,
      resumeRecovery: { pending: true, onCheck },
    },
  );
  const { query } = view;
  expect(query('[role="status"]')).toMatchObject({ textContent: "Resuming goal…" });
  expect(query('[aria-busy="true"]')).not.toBeNull();
  expect(query(".session-run-spinner")).not.toBeNull();
  expect(view.container.textContent).not.toContain("Previous pause");
  view.update({ resumeRecovery: { pending: false, onCheck } });
  expect(query('[role="status"]')).toMatchObject({ textContent: "Resume not confirmed" });
  const retry = query<HTMLButtonElement>(".agent-chat__goal-resume")!;
  expect(retry.textContent).toBe("Retry resume");
  retry.click();
  expect(onCheck).toHaveBeenCalledOnce();
  view.update({ connected: false });
  expect(retry.disabled).toBe(true);
  expect(query(".session-run-spinner")).toBeNull();
});

it("replaces a live tick with the authoritative stop time and resumes ticking", () => {
  const view = mountGoal(goal);
  advanceTime(1_000);
  expect(view.elapsed()).toBe("2m");

  for (const [next, immediate, afterMinute] of [
    [{ ...goal, status: "paused", pausedAt: 46_000 }, "45s", "45s"],
    [goal, "3m", "4m"],
    [{ ...goal, status: "complete", completedAt: 151_000 }, "2m", "2m"],
  ] satisfies [SessionGoal, string, string][]) {
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
    expect(view.elapsed()).toBe("3m");
    expect(vi.getTimerCount()).toBe(1);
  },
);

it("disables only fresh Resume while the session is busy and preserves receipt recovery", () => {
  const onGoalAction = vi.fn();
  const onGoalEdit = vi.fn();
  const onCheck = vi.fn(async () => true);
  const view = mountGoal(
    { ...goal, status: "blocked" },
    {
      canAct: true,
      connected: true,
      resumeBusy: true,
      onGoalAction,
      onGoalEdit,
    },
  );
  const resume = view.query<HTMLButtonElement>('[aria-label="Resume goal"]')!;
  expect(resume.disabled).toBe(true);
  expect(view.query<HTMLButtonElement>('[aria-label="Edit goal"]')!.disabled).toBe(false);
  expect(view.query<HTMLButtonElement>('[aria-label="Clear goal"]')!.disabled).toBe(false);
  resume.click();
  expect(onGoalAction).not.toHaveBeenCalled();
  view.update({ resumeBusy: false });
  expect(resume.disabled).toBe(false);
  resume.click();
  expect(onGoalAction).toHaveBeenCalledExactlyOnceWith(goal.id, "resume");
  view.update({ resumeBusy: true, resumeRecovery: { pending: false, onCheck } });
  view.query<HTMLButtonElement>(".agent-chat__goal-resume")!.click();
  expect(onCheck).toHaveBeenCalledOnce();
});
