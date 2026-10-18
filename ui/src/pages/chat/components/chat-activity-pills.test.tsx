/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionGoal } from "../../../api/types.ts";
import { i18n } from "../../../i18n/index.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatActivityPills, type ChatActivityPillsProps } from "./chat-activity-pills.tsx";

const goal: SessionGoal = {
  schemaVersion: 1,
  id: "release-goal",
  objective: "Verify the release",
  status: "active",
  createdAt: 1,
  updatedAt: 2,
  tokenStart: 0,
  tokensUsed: 100,
  continuationTurns: 0,
};
const fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");

beforeEach(async () => {
  await i18n.setLocale("en");
  Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
});

afterEach(() => {
  cleanupSolid();
  if (fontsDescriptor) {
    Object.defineProperty(document, "fonts", fontsDescriptor);
  } else {
    Reflect.deleteProperty(document, "fonts");
  }
});

function mountPills(initial: ChatActivityPillsProps) {
  let publish: (next: ChatActivityPillsProps) => void;
  const view = mountSolid(() => {
    const [props, setProps] = createSignal(initial);
    publish = setProps;
    return <ChatActivityPills {...props()} />;
  });
  flush();
  return {
    ...view,
    update(next: ChatActivityPillsProps) {
      publish(next);
      flush();
    },
  };
}

it("reports a pursuing goal only after execution is confirmed and opens its current destination", () => {
  const onOpen = vi.fn();
  const initial: ChatActivityPillsProps = {
    presented: true,
    approvalPending: false,
    goal: { value: goal, executionConfirmed: false, onOpen },
  };
  const view = mountPills(initial);
  expect(view.getByRole("button", { name: "Goal active: Verify the release" })).toBeTruthy();
  expect(view.queryByRole("button", { name: /Pursuing goal/ })).toBeNull();

  view.update({ ...initial, goal: { value: goal, executionConfirmed: true, onOpen } });
  const button = view.getByRole<HTMLButtonElement>("button", {
    name: "Pursuing goal: Verify the release",
  });
  button.click();
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(button);

  view.update(initial);
  expect(view.getByRole("button", { name: "Goal active: Verify the release" })).toBeTruthy();
  expect(view.queryByRole("button", { name: /Pursuing goal/ })).toBeNull();
});

it("retains the goal action while approval hides subagent activity, then restores it", () => {
  const onGoal = vi.fn();
  const onSubagents = vi.fn();
  const initial: ChatActivityPillsProps = {
    presented: true,
    approvalPending: false,
    goal: { value: goal, executionConfirmed: false, onOpen: onGoal },
    subagents: {
      activities: [
        {
          session: { key: "agent:main:subagent:review", kind: "direct" },
          key: "agent:main:subagent:review",
          label: "Review the release",
          status: "running",
          listed: true,
        },
      ],
      onOpen: onSubagents,
    },
  };
  const view = mountPills(initial);
  expect(view.getByRole("button", { name: "1 working" })).toBeTruthy();
  view.update({ ...initial, approvalPending: true });
  expect(view.queryByRole("button", { name: "1 working" })).toBeNull();
  const goalButton = view.getByRole<HTMLButtonElement>("button", {
    name: "Goal active: Verify the release",
  });
  goalButton.click();
  expect(onGoal).toHaveBeenCalledExactlyOnceWith(goalButton);
  expect(onSubagents).not.toHaveBeenCalled();

  view.update(initial);
  const subagentButton = view.getByRole<HTMLButtonElement>("button", { name: "1 working" });
  subagentButton.click();
  expect(onSubagents).toHaveBeenCalledExactlyOnceWith(subagentButton);
});
