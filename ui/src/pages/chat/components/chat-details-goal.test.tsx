/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { SessionGoal } from "../../../api/types.ts";
import type { ChatGoalRecovery } from "../../../lib/chat/chat-types.ts";
import {
  installDialogPolyfill,
  waitForRenderedModalDialog,
} from "../../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ChatDetailsGoal } from "./chat-details-goal.tsx";

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

it("retains the objective while hidden and keeps recovery available after the goal is removed", () => {
  vi.useFakeTimers();
  const [value, setValue] = createSignal<SessionGoal | undefined>(goal);
  const [presented, setPresented] = createSignal(true);
  const [recovery, setRecovery] = createSignal<ChatGoalRecovery>();
  const onAction = vi.fn();
  const onCheck = vi.fn(async () => true);
  const view = mountSolid(() => (
    <ChatDetailsGoal
      goal={value()}
      sessionId="session-original"
      presented={presented()}
      connected
      canAct
      recovery={recovery()}
      onGoalAction={onAction}
    />
  ));
  try {
    expect(view.container.textContent).toContain(goal.objective);
    expect(onAction).not.toHaveBeenCalled();
    view.getByRole("button", { name: "Pause goal" }).click();
    expect(onAction).toHaveBeenCalledExactlyOnceWith(goal.id, "pause");
    expect(vi.getTimerCount()).toBe(1);
    setPresented(false);
    flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(view.container.textContent).toContain(goal.objective);
    expect(view.queryByRole("button", { name: "Pause goal" })).toBeNull();
    setValue(undefined);
    setRecovery({ pending: false, action: "clear", goalId: goal.id, onCheck });
    setPresented(true);
    flush();
    expect(view.container.textContent).toContain("No goal");
    view.getByRole("button", { name: "Check outcome" }).click();
    expect(onCheck).toHaveBeenCalledOnce();
    setRecovery({ pending: true, action: "clear", goalId: goal.id, onCheck });
    flush();
    expect(view.getByRole("button", { name: "Check outcome" }).hasAttribute("disabled")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it.each(["session", "goal", "presentation"] as const)(
  "edits multiline objectives through the native modal and retires it on %s change",
  async (changed) => {
    const restore = installDialogPolyfill();
    const pending = createDeferred<boolean>();
    let submissionError: string | null = null;
    const onSubmit = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(true);
    const [sessionId, setSessionId] = createSignal("session-original");
    const [currentGoal, setGoal] = createSignal(goal);
    const [presented, setPresented] = createSignal(true);
    const view = mountSolid(() => (
      <ChatDetailsGoal
        goal={currentGoal()}
        sessionId={sessionId()}
        presented={presented()}
        connected
        canAct
        onGoalAction={vi.fn()}
        onGoalSubmit={onSubmit}
        getGoalSubmitError={() => submissionError}
      />
    ));
    try {
      view.getByRole("button", { name: "Edit goal" }).click();
      const { modal } = await waitForRenderedModalDialog(document.body);
      const input = modal.querySelector("textarea")!;
      const form = modal.querySelector("form")!;
      const save = modal.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      expect(input.value).toBe(goal.objective);
      expect(save.disabled).toBe(true);
      const objective = "  " + goal.objective + "\n";
      input.value = objective;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      expect(save.disabled).toBe(false);
      save.click();
      flush();
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
        action: "edit",
        sessionId: "session-original",
        goalId: goal.id,
        objective,
      });
      expect(input.disabled).toBe(true);
      const cancelled = new CustomEvent("modal-cancel", { cancelable: true });
      modal.dispatchEvent(cancelled);
      expect(cancelled.defaultPrevented).toBe(true);
      submissionError = "Goal update is invalid. Check the objective and try again.";
      pending.resolve(false);
      await pending.promise;
      await Promise.resolve();
      flush();
      expect(modal.querySelector('[role="alert"]')?.textContent).toBe(submissionError);
      expect(input.value).toBe(objective);
      expect(save.disabled).toBe(false);
      setGoal({ ...goal, tokensUsed: 240 });
      flush();
      expect(document.body.contains(modal)).toBe(true);
      expect(input.value).toBe(objective);
      if (changed === "session") {
        setSessionId("session-replacement");
      } else if (changed === "goal") {
        setGoal({ ...goal, id: "goal-replacement" });
      } else {
        setPresented(false);
      }
      flush();
      await Promise.resolve();
      expect(document.body.contains(modal)).toBe(false);
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      expect(onSubmit).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      restore();
    }
  },
);
