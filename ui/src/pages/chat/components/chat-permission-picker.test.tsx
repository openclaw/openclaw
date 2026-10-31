/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { focusChatComposerFromKeydown } from "../chat-pane-shared.ts";
import { ChatPermissionPicker, type ChatPermissionPickerProps } from "./chat-permission-picker.tsx";

it("keeps locked modes unavailable and selects enabled numeric shortcuts with return focus", async () => {
  const onSelect = vi.fn();
  const canSelectFull = vi.fn(() => false);
  const options: ChatPermissionPickerProps = {
    get canSelectFull() {
      return canSelectFull();
    },
    mode: "guarded",
    onSelect,
  };
  const { container } = mountSolid(() => <ChatPermissionPicker {...options} />);
  flush();
  expect(canSelectFull).not.toHaveBeenCalled();
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

it.each(["saved", "failed"])(
  "keeps the pending choice visible until %s, with dismissal",
  async (outcome) => {
    const completion = createDeferred();
    const [state, setState] = createSignal<Pick<ChatPermissionPickerProps, "mode" | "pending">>({});
    const onSelect = vi.fn<ChatPermissionPickerProps["onSelect"]>((mode) => {
      setState({ mode: mode ?? undefined, pending: true });
      return completion.promise;
    });
    const { container } = mountSolid(() => (
      <ChatPermissionPicker canSelectFull defaultMode="guarded" {...state()} onSelect={onSelect} />
    ));
    flush();
    const trigger = container.querySelector<HTMLButtonElement>("[data-chat-permission-select]")!;
    expect(trigger.textContent?.trim()).toBe("Default (Guarded)");
    trigger.click();
    const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
    await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(true));
    expect(
      container
        .querySelector('[data-chat-permission-option="default"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      container
        .querySelector('[data-chat-permission-option="default"]')
        ?.getAttribute("aria-label"),
    ).toBe("Default (Guarded)");
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "4", bubbles: true, cancelable: true }));
    await waitForSolid(() => expect(trigger.getAttribute("aria-busy")).toBe("true"));
    expect(trigger.textContent?.trim()).toBe("Workspace");
    expect(trigger.disabled).toBe(false);
    expect(menu.matches(":popover-open")).toBe(true);
    expect(
      container
        .querySelector('[data-chat-permission-option="workspace"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("[data-chat-permission-option]")].every(
        (row) => row.disabled,
      ),
    ).toBe(true);
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true, cancelable: true }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("workspace");
    if (outcome === "failed") {
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(false));
      setState({ mode: undefined, pending: false });
      completion.reject(new Error("Owner-reported failure"));
    } else {
      setState({ mode: "workspace", pending: false });
      completion.resolve();
    }
    await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(false));
    expect(trigger.getAttribute("aria-busy")).toBeNull();
    expect(trigger.textContent?.trim()).toBe(
      outcome === "failed" ? "Default (Guarded)" : "Workspace",
    );
  },
);

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
  const composer = container.querySelector("textarea")!;
  const redirect = (event: KeyboardEvent) =>
    focusChatComposerFromKeydown(container, event, composer);
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
  expect(row.textContent).toContain("The agent's configured permissions.");
  expect(row.getAttribute("aria-checked")).toBe("false");
  expect(row.getAttribute("aria-label")).toBe("Default (Guarded)");
  expect(container.querySelector('[data-chat-permission-option="guarded"]')?.textContent).toContain(
    "Default",
  );
  expect(
    container
      .querySelector('[data-chat-permission-option="workspace"]')
      ?.getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    container.querySelector('[data-chat-permission-option="full"]')?.matches(":disabled"),
  ).toBe(false);
});
