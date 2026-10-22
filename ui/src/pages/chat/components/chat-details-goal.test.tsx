/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { SessionGoal } from "../../../api/types.ts";
import * as modalHosts from "../../../components/promise-modal-host.ts";
import type { ChatGoalRecovery } from "../../../lib/chat/chat-types.ts";
import {
  installDialogPolyfill,
  waitForRenderedModalDialog,
} from "../../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
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

it("reports failed edit-dialog preparation and permits a fresh attempt", async () => {
  const restore = installDialogPolyfill();
  const prepare = vi
    .spyOn(modalHosts, "withPromiseModalHost")
    .mockRejectedValueOnce(new Error("Goal dialog unavailable. Try again."));
  const view = mountSolid(() => (
    <ChatDetailsGoal
      goal={goal}
      sessionId="session-original"
      presented
      connected
      canAct
      onGoalAction={() => {}}
      onGoalSubmit={async () => true}
    />
  ));
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
    restore();
  }
});

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
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
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
      submissionError = "Goal update is invalid. Check the objective and try again.";
      pending.resolve(false);
      await waitForSolid(() =>
        expect(modal.querySelector('[role="alert"]')?.textContent).toBe(submissionError),
      );
      expect(input.value).toBe(objective);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(save.disabled).toBe(false);
      expect(document.activeElement).toBe(input);
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

it("keeps the goal draft and field identity through a rejected save and retry", async () => {
  const restore = installDialogPolyfill();
  const retry = createDeferred<boolean>();
  const onSubmit = vi
    .fn()
    .mockRejectedValueOnce(new Error("Goal save failed"))
    .mockReturnValue(retry.promise);
  const view = mountSolid(() => (
    <ChatDetailsGoal
      goal={goal}
      sessionId="session-original"
      presented
      connected
      canAct
      onGoalAction={vi.fn()}
      onGoalSubmit={onSubmit}
    />
  ));
  try {
    view.getByRole("button", { name: "Edit goal" }).click();
    const { modal } = await waitForRenderedModalDialog(document.body);
    const input = modal.querySelector("textarea")!;
    const form = modal.querySelector("form")!;
    const objective = "Keep this edited objective";
    input.value = objective;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitForSolid(() => {
      expect(modal.querySelector('[role="alert"]')?.textContent).toBe("Goal save failed");
      expect(input.getAttribute("aria-invalid")).toBe("true");
    });
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(objective);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    flush();
    await waitForSolid(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(modal.querySelector("textarea")).toBe(input);
    expect(input.disabled).toBe(true);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(modal.querySelector('[role="alert"]')).toBeNull();
    retry.resolve(true);
    await waitForSolid(() => expect(document.body.contains(modal)).toBe(false));
  } finally {
    view.unmount();
    restore();
  }
});
