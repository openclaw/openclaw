/* @vitest-environment jsdom */
import { createComponent, createSignal, flush, merge } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  chatPaneHeaderSessionMenu,
  mountChatPaneHeader,
  openNativeMenu,
  selectNativeMenu,
} from "./chat-pane-header.test-support.ts";
import {
  ChatSessionVersionsMobile,
  type ChatSessionVersionsMobileProps,
} from "./chat-session-versions-mobile.tsx";

const containers: HTMLElement[] = [];
const branch = (leafEntryId: string, headline: string, active = false, messageCount = 2) => ({
  leafEntryId,
  headline,
  active,
  messageCount,
});
function mountMobile(overrides: Partial<ChatSessionVersionsMobileProps>) {
  const [props, setProps] = createSignal<ChatSessionVersionsMobileProps>({
    scopeKey: "connection/main/session-a",
    branches: [],
    query: { status: "ready" },
    branchSwitchDisabledReason: null,
    onBranchSelect: vi.fn(),
    ...overrides,
  });
  const view = mountSolid(() => createComponent(ChatSessionVersionsMobile, merge(props)));
  flush();
  const update = (next: Partial<ChatSessionVersionsMobileProps>) => {
    setProps((value) => ({ ...value, ...next }));
    flush();
  };
  return { ...view, update };
}
afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

it("lists versions in the session menu only when the session has them", async () => {
  const header = mountChatPaneHeader(containers, {
    sessionMenuAction: chatPaneHeaderSessionMenu(),
    branches: [branch("only", "Only path", true, 1)],
  });
  const menu = header.container.querySelector("openclaw-chat-header-session-menu")!;
  await openNativeMenu(menu, "submenu:view");
  expect(menu.querySelector('[data-value="submenu:versions"]')).toBeNull();

  header.update({
    branches: [
      branch("active", "Current work", true, 4),
      {
        ...branch("other", "Earlier idea"),
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
  });
  await selectNativeMenu(menu, "submenu:versions");
  const items = menu.querySelectorAll(".chat-pane__branch-item");
  expect(items).toHaveLength(2);
  expect(items[0]?.textContent).toContain("Current work");
  expect(items[0]?.getAttribute("data-active")).toBe("true");
  expect(items[1]?.textContent).toContain("Earlier idea");
  expect(header.container.querySelector(".chat-pane__branches-trigger")).toBeNull();

  await selectNativeMenu(menu, "version:other");
  expect(header.props.onBranchSelect).toHaveBeenCalledExactlyOnceWith("other");
});

it.each([false, true])("keeps version choices live with merged chrome %s", async (mergedChrome) => {
  const first = vi.fn();
  const next = vi.fn();
  const active = { leafEntryId: "active", headline: "Current", messageCount: 1, active: true };
  const { container, update } = mountChatPaneHeader(containers, {
    mergedChrome,
    sessionMenuAction: chatPaneHeaderSessionMenu(),
    branches: [active, { ...active, leafEntryId: "before", active: false }],
    onBranchSelect: first,
  });
  const menu = container.querySelector("openclaw-chat-header-session-menu")!;
  await selectNativeMenu(menu, "submenu:versions");
  update({
    branches: [active, { ...active, leafEntryId: "after", headline: "Updated", active: false }],
    onBranchSelect: next,
    branchSwitchDisabledReason: "Busy",
  });
  const versions = menu.querySelector<HTMLButtonElement>('[data-value="submenu:versions"]');
  await waitForSolid(() => expect(versions?.disabled).toBe(true));
  expect(versions?.title).toBe("Busy");
  update({ branchSwitchDisabledReason: null });
  await selectNativeMenu(menu, "submenu:versions");
  expect(menu.querySelector('[data-value="version:before"]')).toBeNull();
  expect(menu.querySelector('[data-value="version:after"]')?.textContent).toContain("Updated");
  await selectNativeMenu(menu, "version:after");
  expect(next).toHaveBeenCalledExactlyOnceWith("after");
  expect(first).not.toHaveBeenCalled();
});

it("keeps mobile order and selection authoritative across active-first receipts, and resets on scope change", () => {
  const current = branch("current", "Current work", true, 4);
  const earlier = branch("earlier", "Earlier idea");
  const onBranchSelect = vi.fn();
  const view = mountMobile({ branches: [current, earlier], onBranchSelect });
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

  view.update({
    branches: [
      { ...earlier, active: true },
      { ...current, active: false },
    ],
  });
  expect(radios()).toEqual([first, second]);
  expect(second.getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(second);
  expect(first.textContent).toContain("Current work");

  view.update({ scopeKey: "connection/main/session-b", branches: [earlier] });
  expect(radios()).toHaveLength(1);
  expect(radios()[0]?.textContent).toContain("Earlier idea");
  expect(view.container.textContent).toContain("Saved copies of this conversation");
});

it("does not report unknown or failed mobile queries as empty and preserves the owner's disabled reason", () => {
  const onBranchSelect = vi.fn();
  const onRetry = vi.fn();
  const view = mountMobile({
    scopeKey: "connection/main/session",
    query: { status: "loading" },
    onBranchSelect,
    onRetry,
  });
  expect(view.getByRole("status", { name: "Loading…" }).getAttribute("aria-busy")).toBe("true");
  expect(view.container.textContent).not.toContain("No earlier versions yet.");
  view.update({
    query: { status: "error", message: "Connection lost. Retry when connected." },
  });
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
  expect(view.container.textContent).not.toContain("No earlier versions yet.");
  view.container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
  expect(onRetry).toHaveBeenCalledOnce();
  view.update({ query: { status: "ready" } });
  expect(view.container.textContent).toContain("No earlier versions yet.");
  view.update({
    branches: [branch("earlier", "Earlier idea")],
    branchSwitchDisabledReason: "Administrator access is required to switch versions.",
  });
  const radio = view.container.querySelector<HTMLButtonElement>('[role="radio"]')!;
  radio.click();
  expect(radio.getAttribute("aria-disabled")).toBe("true");
  expect(view.container.textContent).toContain("Administrator access is required");
  expect(onBranchSelect).not.toHaveBeenCalled();
});
