/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionGoal } from "../../../api/types.ts";
import { i18n } from "../../../i18n/index.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import type { ChatActivityPillsProps } from "./chat-activity-pills-types.ts";
import { ChatActivityPills } from "./chat-activity-pills.tsx";

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
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: Object.assign(new EventTarget(), { ready: Promise.resolve() }),
  });
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

it("preserves Markdown-only progress refresh outcomes and clears them after recovery", () => {
  const onOpen = vi.fn();
  const progress: NonNullable<ChatActivityPillsProps["progress"]> = {
    card: {
      sessionKey: "agent:main:test",
      revision: 1,
      updatedAt: 1,
      markdown: "Release notes preserved",
    },
    showInChat: true,
    hasActiveRun: false,
    onOpen,
  };
  const initial: ChatActivityPillsProps = {
    presented: true,
    approvalPending: false,
    progress,
  };
  const view = mountPills(initial);
  expect(view.getByRole("button", { name: "Task progress" })).toBeTruthy();
  for (const refresh of ["pending", "failed", "timeout"] as const) {
    view.update({ ...initial, progress: { ...progress, refresh } });
    const status =
      refresh === "pending"
        ? "Updating saved progress"
        : "Progress update unavailable; last plan preserved";
    expect(view.getByRole("button", { name: `Task progress, ${status}` })).toBeTruthy();
  }
  view.update(initial);
  const button = view.getByRole<HTMLButtonElement>("button", { name: "Task progress" });
  expect(view.queryByRole("button", { name: /Progress update unavailable/ })).toBeNull();
  button.click();
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(button);
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

it("follows the current pill order after pull requests move or leave the strip", () => {
  const pullRequest = (
    number: number,
  ): NonNullable<ChatActivityPillsProps["pullRequests"]>["items"][number] => ({
    number,
    owner: "example",
    repo: "project",
    branch: `change-${number}`,
    title: `Review change ${number}`,
    url: `https://github.com/example/project/pull/${number}`,
    state: "open",
  });
  const first = pullRequest(1);
  const second = pullRequest(2);
  const third = pullRequest(3);
  const fourth = pullRequest(4);
  const onOpen = vi.fn();
  const props = (
    items: NonNullable<ChatActivityPillsProps["pullRequests"]>["items"],
  ): ChatActivityPillsProps => ({
    presented: true,
    approvalPending: false,
    pullRequests: { items, status: "ready", onOpen },
  });
  const view = mountPills(props([first, second, third]));
  const button = (number: number) =>
    view.getByRole<HTMLButtonElement>("button", { name: new RegExp(`Review change ${number}`) });
  const press = (key: string, shiftKey = false) => {
    const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(event);
    return event;
  };
  const firstButton = button(1);
  const thirdButton = button(3);
  button(2).focus();
  press("ArrowRight");
  expect(document.activeElement).toBe(thirdButton);

  view.update(props([third, first, second]));
  expect(button(1)).toBe(firstButton);
  expect(button(3)).toBe(thirdButton);
  thirdButton.focus();
  press("ArrowRight");
  expect(document.activeElement).toBe(firstButton);

  view.update(props([third, second, fourth]));
  button(2).focus();
  press("Home");
  expect(document.activeElement).toBe(thirdButton);
  press("End");
  expect(document.activeElement).toBe(button(4));
  press("ArrowLeft");
  expect(document.activeElement).toBe(button(2));
  expect(press("ArrowLeft", true).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(button(2));
  button(4).click();
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(fourth, button(4));
});
