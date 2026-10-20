/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { makeMenu } from "./chat-composer-menu.test-support.ts";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";
import type { ChatComposerPlusMenuProps } from "./chat-composer-plus-menu.types.ts";

type MenuContent = typeof import("./chat-composer-plus-menu-content.tsx");
const contentPath = "./chat-composer-plus-menu-content.tsx";
const makeToggle = (label: string, checked: boolean, onChange: (checked: boolean) => void) => ({
  value: "toggle",
  label,
  checked,
  disabled: false,
  onChange,
});

afterEach(() => vi.doUnmock(contentPath));

function mountMenu() {
  const onChange = vi.fn();
  const [menu, setMenu] = createSignal(
    makeMenu({
      rootToggles: [makeToggle("Original", false, onChange)],
      onOpenChange: (open) => setMenu((current) => ({ ...current, open })),
    }),
  );
  const view = mountSolid(() => <ChatComposerPlusMenu menu={menu()} />);
  view.container.insertAdjacentHTML("afterbegin", '<input aria-label="Other field">');
  const trigger = view.getByRole("button", { name: "Add attachment" });
  const panel = view.container.querySelector(".agent-chat__capability-menu-panel")!;
  const toggle = (label = "Updated") =>
    view.getByRole("menuitemcheckbox", { name: label, hidden: true });
  const isOpen = () => panel.matches(":popover-open");
  const expectTrigger = () =>
    expect(view.getByRole("button", { name: "Add attachment" })).toBe(trigger);
  const update = (patch: Partial<ChatComposerPlusMenuProps>) =>
    setMenu((current) => ({ ...current, ...patch }));
  return { ...view, update, trigger, onChange, toggle, isOpen, expectTrigger };
}

it.each(["keyboard", "last", "pointer", "external", "closed", "reopened"] as const)(
  "keeps the trigger and respects %s focus while menu content loads",
  async (mode) => {
    const ready = createDeferred();
    onTestFinished(() => ready.resolve());
    const load = vi.fn(() => ready.promise.then(() => vi.importActual<MenuContent>(contentPath)));
    vi.doMock(contentPath, load);
    const { trigger, update, isOpen, toggle, getByRole, expectTrigger, onChange } = mountMenu();
    trigger.focus();
    trigger.dispatchEvent(
      mode === "pointer"
        ? new MouseEvent("click", { bubbles: true, detail: 1 })
        : new KeyboardEvent("keydown", {
            key: mode === "last" ? "ArrowUp" : "ArrowDown",
            bubbles: true,
            cancelable: true,
          }),
    );
    await waitForSolid(() => expect([isOpen(), load.mock.calls.length]).toEqual([true, 1]));
    const loading = getByRole("menuitem", { name: "Loading…", hidden: true });
    expect(loading.hasAttribute("disabled")).toBe(true);
    const latestChange = vi.fn();
    update({ rootToggles: [makeToggle("Updated", true, latestChange)] });
    flush();
    const external = getByRole("textbox", { name: "Other field" });
    if (mode === "external") {
      external.focus();
    } else if (mode === "closed" || mode === "reopened") {
      update({ open: false });
      await waitForSolid(() => expect(isOpen()).toBe(false));
      if (mode === "reopened") {
        trigger.click();
        await waitForSolid(() => expect(isOpen()).toBe(true));
      }
    }
    ready.resolve();
    await waitForSolid(() => expect(toggle()).toBeTruthy());
    expectTrigger();
    expect(load).toHaveBeenCalledOnce();
    if (mode === "closed") {
      expect(isOpen()).toBe(false);
    } else if (mode === "external" || mode === "pointer") {
      expect(document.activeElement).toBe(mode === "external" ? external : trigger);
    } else {
      await waitForSolid(() =>
        expect(document.activeElement).toBe(
          mode === "last" ? toggle() : getByRole("menuitem", { name: "Take photo", hidden: true }),
        ),
      );
      toggle().click();
      expect(latestChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(onChange).not.toHaveBeenCalled();
    }
  },
);

it("keeps the menu open and retries a failed content load", async () => {
  vi.doMock(contentPath, () => {
    throw new Error("Chunk failed");
  });
  const view = mountMenu();
  view.trigger.click();
  await waitForSolid(() => expect(view.getByRole("alert").textContent).toContain("Chunk failed"));
  expect(view.isOpen()).toBe(true);
  vi.doUnmock(contentPath);
  view.getByRole("button", { name: "Retry" }).click();
  await waitForSolid(() => expect(view.toggle("Original")).toBeTruthy());
  view.expectTrigger();
  expect(view.isOpen()).toBe(true);
});
