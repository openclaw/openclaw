/* @vitest-environment jsdom */
import { createSignal, type Setter } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { makeMenu } from "./chat-composer-menu.test-support.ts";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";
import type { ChatComposerPlusMenuProps } from "./chat-composer-plus-menu.types.ts";

afterEach(() => {
  vi.doUnmock("./chat-composer-plus-menu-content.tsx");
});

const toggle = (label: string, onChange: (checked: boolean) => void, checked = false) => ({
  value: "toggle",
  label,
  checked,
  disabled: false,
  onChange,
});
const keydown = (target: Element, key: string) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

function mountMenu() {
  const onChange = vi.fn();
  let setMenu!: Setter<ChatComposerPlusMenuProps>;
  const view = mountSolid(() => {
    const [menu, update] = createSignal<ChatComposerPlusMenuProps>(
      makeMenu({
        rootToggles: [toggle("Original toggle", onChange)],
        onOpenChange: (open) => update((current) => ({ ...current, open })),
      }),
    );
    setMenu = update;
    return (
      <>
        <input aria-label="Other field" />
        <ChatComposerPlusMenu menu={menu()} />
      </>
    );
  });
  const triggerSelector = ".agent-chat__input-btn--attach";
  const trigger = view.container.querySelector<HTMLButtonElement>(triggerSelector)!;
  const panel = view.container.querySelector(".agent-chat__capability-menu-panel")!;
  const item = (name: string) => view.getByRole("menuitemcheckbox", { name, hidden: true });
  const expectOpen = (open = true) =>
    waitForSolid(() => expect(panel.matches(":popover-open")).toBe(open));
  const expectTrigger = () => expect(view.container.querySelector(triggerSelector)).toBe(trigger);
  return { ...view, setMenu, trigger, panel, onChange, item, expectOpen, expectTrigger };
}

it.each(["keyboard", "last", "pointer", "external", "closed", "reopened"] as const)(
  "keeps the trigger and respects %s focus while menu content loads",
  async (mode) => {
    const entered = createDeferred();
    const imported = createDeferred();
    const ready = createDeferred();
    onTestFinished(() => ready.resolve());
    vi.doMock("./chat-composer-plus-menu-content.tsx", async () => {
      entered.resolve();
      await ready.promise;
      try {
        return await vi.importActual<typeof import("./chat-composer-plus-menu-content.tsx")>(
          "./chat-composer-plus-menu-content.tsx",
        );
      } finally {
        imported.resolve();
      }
    });
    const view = mountMenu();
    view.trigger.focus();
    if (mode === "pointer") {
      view.trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    } else {
      keydown(view.trigger, mode === "last" ? "ArrowUp" : "ArrowDown");
    }
    // Cold module work precedes Solid's DOM settlement window.
    await entered.promise;
    await view.expectOpen();
    expect(
      view.getByRole("menuitem", { name: "Loading…", hidden: true }).hasAttribute("disabled"),
    ).toBe(true);
    const latestChange = vi.fn();
    view.setMenu((current) => ({
      ...current,
      rootToggles: [toggle("Updated toggle", latestChange, true)],
    }));
    flush();
    const external = view.getByRole("textbox", { name: "Other field" });
    if (mode === "external") {
      external.focus();
      await waitForSolid(() => expect(view.panel.matches(":popover-open")).toBe(false));
    } else if (mode === "closed" || mode === "reopened") {
      view.setMenu((current) => ({ ...current, open: false }));
      await view.expectOpen(false);
      if (mode === "reopened") {
        view.trigger.click();
        await view.expectOpen();
      }
    }
    const readCapabilities = vi.fn(() => undefined);
    const initializeCapabilities = vi.fn();
    if (mode === "closed" || mode === "external") {
      view.setMenu((current) => ({
        ...current,
        capabilityMenu: { read: readCapabilities, initialize: initializeCapabilities },
      }));
      flush();
    }
    ready.resolve();
    await imported.promise;
    await import("./chat-composer-plus-menu-content.tsx");
    flush();
    view.expectTrigger();
    if (mode === "closed" || mode === "external") {
      await view.expectOpen(false);
      expect(
        view.queryByRole("menuitemcheckbox", { name: "Updated toggle", hidden: true }),
      ).toBeNull();
      expect(readCapabilities).not.toHaveBeenCalled();
      expect(initializeCapabilities).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(mode === "external" ? external : view.trigger);
      view.setMenu((current) => ({ ...current, capabilityMenu: undefined }));
      view.trigger.click();
      await waitForSolid(() => expect(view.item("Updated toggle")).toBeTruthy());
      await view.expectOpen();
      return;
    }
    await waitForSolid(() => expect(view.item("Updated toggle")).toBeTruthy());
    if (mode === "pointer") {
      expect(document.activeElement).toBe(view.trigger);
    } else {
      await waitForSolid(() =>
        expect(document.activeElement).toBe(
          mode === "last"
            ? view.item("Updated toggle")
            : view.getByRole("menuitem", { name: "Camera", hidden: true }),
        ),
      );
      view.item("Updated toggle").click();
      expect(latestChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(view.onChange).not.toHaveBeenCalled();
    }
  },
);

it("keeps the menu open and retries a failed content load", async () => {
  // mock-isolation: reject the chunk import itself to exercise the visible retry path.
  vi.doMock("./chat-composer-plus-menu-content.tsx", () => {
    throw new Error("Menu chunk could not be loaded");
  });
  const view = mountMenu();
  view.trigger.click();
  await waitForSolid(() => expect(view.getByRole("alert")).toBeTruthy());
  expect(view.panel.matches(":popover-open")).toBe(true);
  expect(view.getByRole("alert").textContent).toContain("Menu chunk could not be loaded");
  vi.doUnmock("./chat-composer-plus-menu-content.tsx");
  view.getByRole("button", { name: "Retry" }).click();
  await waitForSolid(() => expect(view.item("Original toggle")).toBeTruthy());
  view.expectTrigger();
  expect(view.panel.matches(":popover-open")).toBe(true);
});
