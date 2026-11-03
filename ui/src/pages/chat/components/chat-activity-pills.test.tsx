/* @vitest-environment jsdom */

import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "@openclaw/gateway-protocol";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionGoalFixture } from "../../../../../src/gateway/session-goal.test-support.js";
import type { ApplicationContext } from "../../../app/context.ts";
import { i18n } from "../../../i18n/index.ts";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import { createContext, createGateway, createSessions } from "../../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../../../test-helpers/property-descriptor.ts";
import { installRepositoryPresentation } from "../../../test-helpers/repository-presentation.test-support.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatActivityPillsProps } from "./chat-activity-pills-types.ts";
import { ChatActivityPills } from "./chat-activity-pills.tsx";

const goal = createSessionGoalFixture("release-goal", "Verify the release");
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
  restorePropertyDescriptor(document, "fonts", fontsDescriptor);
});

function mountPills(initial: Partial<ChatActivityPillsProps>, context?: ApplicationContext) {
  let publish: (next: Partial<ChatActivityPillsProps>) => void;
  const view = mountSolid(() => {
    const [props, setProps] = createSignal<ChatActivityPillsProps>({
      presented: true,
      approvalPending: false,
      ...initial,
    });
    publish = (next) => setProps((current) => ({ ...current, ...next }));
    return context ? (
      <ApplicationProvider value={context}>
        <ChatActivityPills {...props()} />
      </ApplicationProvider>
    ) : (
      <ChatActivityPills {...props()} />
    );
  });
  flush();
  return {
    ...view,
    button: (name: string | RegExp) => view.getByRole<HTMLButtonElement>("button", { name }),
    update(next: Partial<ChatActivityPillsProps>) {
      publish(next);
      flush();
    },
  };
}

it("reports a pursuing goal only after execution is confirmed and opens its current destination", () => {
  const onOpen = vi.fn();
  const initial = { value: goal, executionConfirmed: false, onOpen };
  const view = mountPills({ goal: initial });
  expect(view.button("Goal active: Verify the release")).toBeTruthy();
  expect(view.queryByRole("button", { name: /Pursuing goal/ })).toBeNull();

  view.update({ goal: { ...initial, executionConfirmed: true } });
  const button = view.button("Pursuing goal: Verify the release");
  button.click();
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(button);

  view.update({ goal: initial });
  expect(view.button("Goal active: Verify the release")).toBeTruthy();
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
    hasActiveRun: false,
    onOpen,
  };
  const view = mountPills({ progress });
  expect(view.button("Task progress")).toBeTruthy();
  for (const refresh of ["pending", "failed", "timeout"] as const) {
    view.update({ progress: { ...progress, refresh } });
    const status =
      refresh === "pending"
        ? "Updating saved progress"
        : "Progress update unavailable; last plan preserved";
    expect(view.button(`Task progress, ${status}`)).toBeTruthy();
  }
  view.update({ progress });
  const button = view.button("Task progress");
  expect(view.queryByRole("button", { name: /Progress update unavailable/ })).toBeNull();
  button.click();
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(button);
});

it("retains the goal action while approval hides subagent activity, then restores it", () => {
  const onGoal = vi.fn();
  const onSubagents = vi.fn();
  const view = mountPills({
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
  });
  expect(view.button("1 working")).toBeTruthy();
  view.update({ approvalPending: true });
  expect(view.queryByRole("button", { name: "1 working" })).toBeNull();
  const goalButton = view.button("Goal active: Verify the release");
  goalButton.click();
  expect(onGoal).toHaveBeenCalledExactlyOnceWith(goalButton);
  expect(onSubagents).not.toHaveBeenCalled();

  view.update({ approvalPending: false });
  const subagentButton = view.button("1 working");
  subagentButton.click();
  expect(onSubagents).toHaveBeenCalledExactlyOnceWith(subagentButton);
});

it("follows the current contributed pill order after pull requests move or leave the strip", async () => {
  const pullRequest = (number: number): ControlUiSessionPullRequest => ({
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
  let snapshot: ControlUiSessionPullRequestSnapshot = {
    pullRequests: [first, second, third],
    status: "ready",
    rateLimited: false,
  };
  const context = createContext(
    createGateway(createTestGatewayClient(async () => ({}))),
    createSessions("main", []),
  );
  const presentation = installRepositoryPresentation(context, () => snapshot);
  const props: ChatActivityPillsProps = {
    presented: true,
    approvalPending: false,
    contributions: { sessionKey: "agent:main:pills", onOpenDetailsPage: onOpen },
  };
  const view = mountPills(props, presentation.context);
  const update = (items: ControlUiSessionPullRequest[]) => {
    snapshot = { ...snapshot, pullRequests: items };
    presentation.notify();
    flush();
  };
  await waitForSolid(() =>
    expect(view.queryByRole("button", { name: /Review change 1/ })).not.toBeNull(),
  );
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

  update([third, first, second]);
  expect(button(1)).toBe(firstButton);
  expect(button(3)).toBe(thirdButton);
  thirdButton.focus();
  press("ArrowRight");
  expect(document.activeElement).toBe(firstButton);

  update([third, second, fourth]);
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
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(
    "github-repositories",
    { id: "pull-request:example/project#4", title: fourth.title },
    button(4),
  );
});
