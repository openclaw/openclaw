/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { SessionGoal } from "../../../api/types.ts";
import * as modalHosts from "../../../components/promise-modal-host.ts";
import {
  installDialogPolyfill,
  waitForRenderedModalDialog,
} from "../../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatDetailsGoal } from "./chat-details-goal.tsx";

type GoalProps = Parameters<typeof ChatDetailsGoal>[0];
const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .toReversed()
    .forEach((cleanup) => cleanup()),
);
function createGoalView(initial: Partial<GoalProps>) {
  const [props, setProps] = createSignal(initial);
  const restore = installDialogPolyfill();
  const view = mountSolid(() => (
    <ChatDetailsGoal
      goal={goal}
      sessionId="session-original"
      presented
      connected
      canAct
      onGoalAction={() => {}}
      {...props()}
    />
  ));
  cleanups.push(() => {
    view.unmount();
    restore();
  });
  return Object.assign(view, {
    update(next: Partial<GoalProps>) {
      setProps((current) => ({ ...current, ...next }));
      flush();
    },
  });
}
function enterObjective(input: HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}
const submit = (form: HTMLFormElement) =>
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

const goal: SessionGoal = {
  schemaVersion: 1,
  id: "goal-details",
  objective: "Review the release\nPreserve the checklist",
  status: "active",
  createdAt: 1000,
  updatedAt: 2000,
  tokenStart: 0,
  tokensUsed: 120,
  continuationTurns: 0,
};

it("reports failed edit-dialog preparation and permits a fresh attempt", async () => {
  const prepare = vi
    .spyOn(modalHosts, "withPromiseModalHost")
    .mockRejectedValueOnce(new Error("Goal dialog unavailable. Try again."));
  const view = createGoalView({ onGoalSubmit: async () => true });
  try {
    view.getByRole("button", { name: "Edit goal" }).click();
    view.getByRole("button", { name: "Edit goal" }).click();
    await waitForSolid(() =>
      expect(view.getByRole("alert").textContent).toBe("Goal dialog unavailable. Try again."),
    );
    expect(prepare).toHaveBeenCalledOnce();
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    view.getByRole("button", { name: "Edit goal" }).click();
    const { modal } = await waitForRenderedModalDialog(document.body);
    await waitForSolid(() => expect(view.queryByRole("alert")).toBeNull());
    expect(modal.querySelector("textarea")?.value).toBe(goal.objective);
    modal.querySelector<HTMLButtonElement>('button[type="button"]')!.click();
  } finally {
    view.unmount();
    prepare.mockRestore();
  }
});

it("retains the objective while hidden and keeps recovery available after the goal is removed", () => {
  vi.useFakeTimers();
  const onAction = vi.fn();
  const onCheck = vi.fn(async () => true);
  const view = createGoalView({ onGoalAction: onAction });
  try {
    expect(view.container.textContent).toContain(goal.objective);
    view.getByRole("button", { name: "Pause goal" }).click();
    expect(onAction).toHaveBeenCalledExactlyOnceWith(goal.id, "pause");
    expect(vi.getTimerCount()).toBe(1);
    view.update({ presented: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(view.container.textContent).toContain(goal.objective);
    expect(view.queryByRole("button", { name: "Pause goal" })).toBeNull();
    view.update({
      goal: undefined,
      presented: true,
      recovery: { pending: false, action: "clear", goalId: goal.id, onCheck },
    });
    expect(view.container.textContent).toContain("No goal");
    view.getByRole("button", { name: "Check outcome" }).click();
    expect(onCheck).toHaveBeenCalledOnce();
    view.update({ recovery: { pending: true, action: "clear", goalId: goal.id, onCheck } });
    expect(view.getByRole("button", { name: "Check outcome" }).hasAttribute("disabled")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it.each(["session", "goal", "presentation", "retry"] as const)(
  "retains a rejected goal edit through %s",
  async (changed) => {
    const pending = createDeferred<boolean>();
    const retry = createDeferred<boolean>();
    let submissionError: string | null = null;
    const onSubmit = vi.fn().mockReturnValueOnce(pending.promise).mockReturnValue(retry.promise);
    const view = createGoalView({
      onGoalSubmit: onSubmit,
      getGoalSubmitError: () => submissionError,
    });
    view.getByRole("button", { name: "Edit goal" }).click();
    const { modal } = await waitForRenderedModalDialog(document.body);
    const input = modal.querySelector("textarea")!;
    const form = modal.querySelector("form")!;
    const save = modal.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(input.value).toBe(goal.objective);
    expect(save.disabled).toBe(true);
    const objective = "  " + goal.objective + "\n";
    enterObjective(input, objective);
    expect(save.disabled).toBe(false);
    save.click();
    submit(form);
    flush();
    await waitForSolid(() =>
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
        action: "edit",
        sessionId: "session-original",
        goalId: goal.id,
        objective,
      }),
    );
    expect(input.disabled).toBe(true);
    const cancelled = new CustomEvent("modal-cancel", { cancelable: true });
    modal.dispatchEvent(cancelled);
    expect(cancelled.defaultPrevented).toBe(true);
    const callbackFailure = changed === "retry";
    submissionError = callbackFailure
      ? "Goal save failed"
      : "Goal update is invalid. Check the objective and try again.";
    if (callbackFailure) {
      pending.reject(new Error(submissionError));
    } else {
      pending.resolve(false);
    }
    await waitForSolid(() =>
      expect(modal.querySelector('[role="alert"]')?.textContent).toBe(submissionError),
    );
    expect(input.value).toBe(objective);
    expect(input.disabled).toBe(false);
    expect(input.getAttribute("aria-invalid")).toBe(callbackFailure ? null : "true");
    expect(save.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    if (callbackFailure) {
      submit(form);
      submit(form);
      flush();
      await waitForSolid(() => expect(onSubmit).toHaveBeenCalledTimes(2));
      expect(modal.querySelector("textarea")).toBe(input);
      expect(input.disabled).toBe(true);
      expect(input.hasAttribute("aria-invalid")).toBe(false);
      expect(modal.querySelector('[role="alert"]')).toBeNull();
      retry.resolve(true);
      await waitForSolid(() => expect(document.body.contains(modal)).toBe(false));
      return;
    }
    view.update({ goal: { ...goal, tokensUsed: 240 } });
    expect(document.body.contains(modal)).toBe(true);
    expect(input.value).toBe(objective);
    if (changed === "session") {
      view.update({ sessionId: "session-replacement" });
    } else if (changed === "goal") {
      view.update({ goal: { ...goal, id: "goal-replacement" } });
    } else {
      view.update({ presented: false });
    }
    await Promise.resolve();
    expect(document.body.contains(modal)).toBe(false);
    submit(form);
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  },
);
