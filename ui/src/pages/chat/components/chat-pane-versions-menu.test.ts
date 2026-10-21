/* @vitest-environment jsdom */
import { createComponent, createSignal, flush, merge } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { mountChatPaneHeader, openNativeMenu } from "./chat-pane-header.test-support.ts";
import {
  ChatSessionVersionsMobile,
  type ChatSessionVersionsMobileProps,
} from "./chat-session-versions-mobile.tsx";

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
  await waitForSolid(() => {
    expect(one.container.querySelector("openclaw-chat-pane-versions-menu")).not.toBeNull();
    expect(one.container.querySelector(".chat-pane__branches-trigger")).toBeNull();
  });

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
  await waitForSolid(() =>
    expect(multiple.container.querySelector(".chat-pane__branches-menu")).not.toBeNull(),
  );
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
  await waitForSolid(() =>
    expect(
      container.querySelector<HTMLButtonElement>(".chat-pane__branches-trigger")?.disabled,
    ).toBe(true),
  );
  const trigger = container.querySelector<HTMLButtonElement>(".chat-pane__branches-trigger");
  trigger?.click();
  await Promise.resolve();
  flush();
  container.querySelector<HTMLButtonElement>('[data-value="other"]')?.click();
  await Promise.resolve();
  expect(props.onBranchSelect).not.toHaveBeenCalled();
});

it("keeps mobile order and selection authoritative across active-first receipts, and resets on scope change", () => {
  const current = {
    leafEntryId: "current",
    headline: "Current work",
    messageCount: 4,
    active: true,
  };
  const earlier = {
    leafEntryId: "earlier",
    headline: "Earlier idea",
    messageCount: 2,
    active: false,
  };
  const onBranchSelect = vi.fn();
  const [props, setProps] = createSignal<ChatSessionVersionsMobileProps>({
    scopeKey: "connection/main/session-a",
    branches: [current, earlier],
    query: { status: "ready" },
    branchSwitchDisabledReason: null,
    onBranchSelect,
  });
  const view = mountSolid(() => createComponent(ChatSessionVersionsMobile, merge(props)));
  onTestFinished(view.unmount);
  flush();
  const radios = () =>
    Array.from(view.container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  const first = radios()[0]!;
  const second = radios()[1]!;
  first.focus();
  first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(document.activeElement).toBe(second);
  expect(onBranchSelect).toHaveBeenCalledWith("earlier");
  expect(first.getAttribute("aria-checked")).toBe("true");
  expect(second.getAttribute("aria-checked")).toBe("false");

  setProps((value) => ({
    ...value,
    branches: [
      { ...earlier, active: true },
      { ...current, active: false },
    ],
  }));
  flush();
  expect(radios()).toEqual([first, second]);
  expect(second.getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(second);
  expect(first.textContent).toContain("Current work");

  setProps((value) => ({ ...value, scopeKey: "connection/main/session-b", branches: [earlier] }));
  flush();
  expect(radios()).toHaveLength(1);
  expect(radios()[0]?.textContent).toContain("Earlier idea");
  expect(view.container.textContent).toContain("Saved copies of this conversation");
});

it("does not report unknown or failed mobile queries as empty and preserves the owner's disabled reason", () => {
  const onBranchSelect = vi.fn();
  const onRetry = vi.fn();
  const [props, setProps] = createSignal<ChatSessionVersionsMobileProps>({
    scopeKey: "connection/main/session",
    branches: [],
    query: { status: "loading" },
    branchSwitchDisabledReason: null,
    onBranchSelect,
    onRetry,
  });
  const view = mountSolid(() => createComponent(ChatSessionVersionsMobile, merge(props)));
  onTestFinished(view.unmount);
  flush();
  expect(view.getByRole("status", { name: "Loading…" }).getAttribute("aria-busy")).toBe("true");
  expect(view.container.textContent).not.toContain("No earlier versions");
  setProps((value) => ({
    ...value,
    query: { status: "error", message: "Connection lost. Retry when connected." },
  }));
  flush();
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
  expect(view.container.textContent).not.toContain("No earlier versions");
  view.container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
  expect(onRetry).toHaveBeenCalledOnce();
  setProps((value) => ({ ...value, query: { status: "ready" } }));
  flush();
  expect(view.container.textContent).toContain("No earlier versions");
  setProps((value) => ({
    ...value,
    branches: [
      { leafEntryId: "earlier", headline: "Earlier idea", messageCount: 2, active: false },
    ],
    branchSwitchDisabledReason: "Administrator access is required to switch versions.",
  }));
  flush();
  const radio = view.container.querySelector<HTMLButtonElement>('[role="radio"]')!;
  radio.click();
  expect(radio.getAttribute("aria-disabled")).toBe("true");
  expect(view.container.textContent).toContain("Administrator access is required");
  expect(onBranchSelect).not.toHaveBeenCalled();
});
