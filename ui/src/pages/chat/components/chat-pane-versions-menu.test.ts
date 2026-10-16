/* @vitest-environment jsdom */
import { flush } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { mountChatPaneHeader, openNativeMenu } from "./chat-pane-header.test-support.ts";

const containers: HTMLElement[] = [];
afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

it("hides one branch and lists multiple branches with the active tip marked", async () => {
  const one = mountChatPaneHeader(containers, {
    branches: [{ leafEntryId: "only", headline: "Only path", messageCount: 1, active: true }],
  });
  await one.container.querySelector("openclaw-chat-pane-versions-menu")?.updateComplete;
  expect(one.container.querySelector(".chat-pane__branches-trigger")).toBeNull();

  const multiple = mountChatPaneHeader(containers, {
    branches: [
      { leafEntryId: "active", headline: "Current work", messageCount: 4, active: true },
      {
        leafEntryId: "other",
        headline: "Earlier idea",
        messageCount: 2,
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
        active: false,
      },
    ],
  });
  await multiple.container.querySelector("openclaw-chat-pane-versions-menu")?.updateComplete;
  const menu = multiple.container.querySelector(".chat-pane__branches-menu")!;
  const trigger = menu.querySelector<HTMLButtonElement>(".oc-menu-trigger");
  expect(trigger?.classList.contains("chat-pane__branches-trigger")).toBe(true);
  await openNativeMenu(menu);
  const items = multiple.container.querySelectorAll(".chat-pane__branch-item");
  expect(items).toHaveLength(2);
  expect(items[0]?.textContent).toContain("Current work");
  expect(items[0]?.getAttribute("data-active")).toBe("true");
  expect(items[0]?.querySelector(".chat-pane__branch-active")).not.toBeNull();
  expect(items[1]?.textContent).toContain("Earlier idea");

  multiple.container.querySelector<HTMLButtonElement>('[data-value="other"]')?.click();
  await Promise.resolve();
  expect(multiple.props.onBranchSelect).toHaveBeenCalledWith("other");
});

it("disables branch switching while the agent is working", async () => {
  const { container, props } = mountChatPaneHeader(containers, {
    branchSwitchDisabledReason: "Branch switch is unavailable while the agent is working.",
    branches: [
      { leafEntryId: "active", headline: "Current work", messageCount: 4, active: true },
      { leafEntryId: "other", headline: "Earlier idea", messageCount: 2, active: false },
    ],
  });
  await container.querySelector("openclaw-chat-pane-versions-menu")?.updateComplete;
  const trigger = container.querySelector<HTMLButtonElement>(".chat-pane__branches-trigger");
  expect(trigger?.disabled).toBe(true);
  trigger?.click();
  await Promise.resolve();
  flush();
  container.querySelector<HTMLButtonElement>('[data-value="other"]')?.click();
  await Promise.resolve();
  expect(props.onBranchSelect).not.toHaveBeenCalled();
});
