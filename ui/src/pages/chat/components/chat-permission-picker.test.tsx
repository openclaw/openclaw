/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { focusChatComposerFromPrintableKeydown } from "../chat-pane-shared.ts";
import { ChatPermissionPicker, type ChatPermissionPickerProps } from "./chat-permission-picker.tsx";

it("keeps locked modes unavailable and selects enabled numeric shortcuts with return focus", async () => {
  const onSelect = vi.fn();
  const { container } = mountSolid(() => (
    <ChatPermissionPicker canSelectFull={false} mode="guarded" onSelect={onSelect} />
  ));
  flush();
  const trigger = container.querySelector<HTMLButtonElement>("[data-chat-permission-select]")!;
  trigger.focus();
  trigger.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }));
  const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
  await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(true));
  expect(document.activeElement).toBe(trigger);
  expect(
    container.querySelector('[data-chat-permission-option="full"]')?.matches(":disabled"),
  ).toBe(true);
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "5", bubbles: true, cancelable: true }));
  expect(onSelect).not.toHaveBeenCalled();
  expect(menu.matches(":popover-open")).toBe(true);
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "4", bubbles: true, cancelable: true }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("workspace");
  expect(document.activeElement).toBe(trigger);
});

it("includes the documentation link in keyboard menu navigation", async () => {
  const { container } = mountSolid(() => (
    <ChatPermissionPicker canSelectFull={false} onSelect={() => {}} />
  ));
  flush();
  const trigger = container.querySelector<HTMLButtonElement>("[data-chat-permission-select]")!;
  trigger.focus();
  trigger.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  await waitForSolid(() =>
    expect(container.querySelector(".chat-controls__permission-learn-more")).not.toBeNull(),
  );
  const link = container.querySelector<HTMLAnchorElement>(".chat-controls__permission-learn-more")!;
  await waitForSolid(() => expect(document.activeElement).toBe(link));
  expect(link.getAttribute("href")).toBe("https://docs.openclaw.ai/gateway/permission-modes");
  expect(link.target).toBe("_blank");
  link.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  await waitForSolid(() =>
    expect(document.activeElement).toBe(
      container.querySelector('[data-chat-permission-option="default"]'),
    ),
  );
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
  );
  await waitForSolid(() => expect(document.activeElement).toBe(link));
});

it("keeps declared shortcuts in the menu and forwards ordinary typing to the composer", async () => {
  const onSelect = vi.fn();
  const { container } = mountSolid(() => (
    <>
      <div class="agent-chat__composer-combobox">
        <textarea />
      </div>
      <ChatPermissionPicker canSelectFull={false} mode="guarded" onSelect={onSelect} />
    </>
  ));
  flush();
  const redirect = (event: KeyboardEvent) =>
    focusChatComposerFromPrintableKeydown(container, event);
  document.addEventListener("keydown", redirect, true);
  onTestFinished(() => document.removeEventListener("keydown", redirect, true));
  const trigger = container.querySelector<HTMLButtonElement>("[data-chat-permission-select]")!;
  const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
  container.querySelector("textarea")!.focus();
  trigger.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }));
  await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(true));
  expect(document.activeElement).toBe(trigger);
  trigger.dispatchEvent(
    new KeyboardEvent("keydown", { key: "4", bubbles: true, cancelable: true }),
  );
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("workspace");
  expect(document.activeElement).toBe(trigger);
  trigger.click();
  await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(true));
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "q", bubbles: true, cancelable: true }),
  );
  expect(document.activeElement).toBe(container.querySelector("textarea"));
  expect(onSelect).toHaveBeenCalledTimes(1);
});

it("preserves option content on unrelated refreshes while admitting permission changes", async () => {
  const options: ChatPermissionPickerProps = { canSelectFull: false, onSelect: vi.fn() };
  const [props, setProps] = createSignal(options);
  const { container } = mountSolid(() => <ChatPermissionPicker {...props()} />);
  flush();
  container.querySelector<HTMLButtonElement>("[data-chat-permission-select]")!.click();
  await waitForSolid(() =>
    expect(container.querySelector('[role="menu"]')?.matches(":popover-open")).toBe(true),
  );
  const row = container.querySelector<HTMLElement>('[data-chat-permission-option="default"]')!;
  const content = row.querySelector(".chat-controls__permission-option-copy");
  const icon = row.querySelector(".chat-controls__permission-option-icon");
  const observer = new MutationObserver(() => {});
  observer.observe(container, { childList: true, subtree: true });
  onTestFinished(() => observer.disconnect());

  options.disabledReason = "Unrelated connection notice";
  setProps({ ...options });
  flush();
  expect(observer.takeRecords()).toHaveLength(0);
  expect(row.querySelector(".chat-controls__permission-option-copy")).toBe(content);
  expect(row.querySelector(".chat-controls__permission-option-icon")).toBe(icon);

  options.defaultMode = "guarded";
  options.mode = "workspace";
  options.canSelectFull = true;
  setProps({ ...options });
  flush();
  expect(container.querySelector('[data-chat-permission-option="default"]')).toBe(row);
  expect(row.textContent).toContain("Default (Guarded)");
  expect(
    container
      .querySelector('[data-chat-permission-option="workspace"]')
      ?.getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    container.querySelector('[data-chat-permission-option="full"]')?.matches(":disabled"),
  ).toBe(false);
});
