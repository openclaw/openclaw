import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import type { ChatSubagentWait } from "../chat-subagent-wait.ts";
import { ComposerRunStatusContent } from "./chat-composer-run-status.tsx";

it.each([
  { runningCount: 0, label: "Waiting on subagents", canView: true },
  { runningCount: 3, label: "Waiting on 3 subagents", canView: true },
  { runningCount: 0, sessionCount: 1, label: "Waiting on 1 session", canView: false },
  { runningCount: 0, sessionCount: 2, label: "Waiting on 2 sessions", canView: false },
])("names $label without inventing child details", ({ label, canView, ...counts }) => {
  const onOpenSubagents = vi.fn();
  const waitingSubagents: ChatSubagentWait = { startedAt: null, ...counts };
  const view = mountSolid(() => (
    <ComposerRunStatusContent
      waitingSubagents={waitingSubagents}
      working={false}
      onOpenSubagents={onOpenSubagents}
    />
  ));
  expect(view.container.textContent).toContain(label);
  expect(view.container.querySelector("openclaw-elapsed-time")).toBeNull();
  const button = view.container.querySelector<HTMLButtonElement>("button");
  expect(Boolean(button)).toBe(canView);
  button?.click();
  if (canView) {
    expect(onOpenSubagents).toHaveBeenCalledExactlyOnceWith(true);
  } else {
    expect(onOpenSubagents).not.toHaveBeenCalled();
  }
});
