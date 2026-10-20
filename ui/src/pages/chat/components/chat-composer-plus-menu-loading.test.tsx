/* @vitest-environment jsdom */
import { createSignal, type Setter } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { makeMenu } from "./chat-composer-menu.test-support.ts";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";
import type { ChatComposerPlusMenuProps } from "./chat-composer-plus-menu.types.ts";

afterEach(() => {
  cleanupSolid();
  vi.doUnmock("./chat-composer-plus-menu-content.tsx");
});

function mountMenu() {
  const onChange = vi.fn();
  let setMenu!: Setter<ChatComposerPlusMenuProps>;
  const view = mountSolid(() => {
    const [menu, update] = createSignal<ChatComposerPlusMenuProps>(
      makeMenu({
        rootToggles: [
          { value: "toggle", label: "Original toggle", checked: false, disabled: false, onChange },
        ],
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
  const trigger = view.container.querySelector<HTMLButtonElement>(
    ".agent-chat__input-btn--attach",
  )!;
  const panel = view.container.querySelector(".agent-chat__capability-menu-panel")!;
  const toggle = (label = "Updated toggle") =>
    view.getByRole("menuitemcheckbox", { name: label, hidden: true });
  const isOpen = () => panel.matches(":popover-open");
  const expectTrigger = () =>
    expect(view.container.querySelector(".agent-chat__input-btn--attach")).toBe(trigger);
  return { ...view, setMenu, trigger, panel, onChange, toggle, isOpen, expectTrigger };
}

it.each(["keyboard", "last", "pointer", "external", "closed", "reopened"] as const)(
  "keeps the trigger and respects %s focus while menu content loads",
  async (mode) => {
    const ready = createDeferred();
    onTestFinished(() => ready.resolve());
    let loads = 0;
    vi.doMock("./chat-composer-plus-menu-content.tsx", async () => {
      loads++;
      await ready.promise;
      return vi.importActual<typeof import("./chat-composer-plus-menu-content.tsx")>(
        "./chat-composer-plus-menu-content.tsx",
      );
    });
    const view = mountMenu();
    view.trigger.focus();
    if (mode === "pointer") {
      view.trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    } else {
      view.trigger.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: mode === "last" ? "ArrowUp" : "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    await waitForSolid(() => {
      expect(view.isOpen()).toBe(true);
      expect(loads).toBe(1);
    });
    expect(
      view.getByRole("menuitem", { name: "Loading…", hidden: true }).hasAttribute("disabled"),
    ).toBe(true);
    const latestChange = vi.fn();
    view.setMenu((current) => ({
      ...current,
      rootToggles: [
        {
          value: "toggle",
          label: "Updated toggle",
          checked: true,
          disabled: false,
          onChange: latestChange,
        },
      ],
    }));
    flush();
    const external = view.getByRole("textbox", { name: "Other field" });
    if (mode === "external") {
      external.focus();
    } else if (mode === "closed" || mode === "reopened") {
      view.setMenu((current) => ({ ...current, open: false }));
      await waitForSolid(() => expect(view.isOpen()).toBe(false));
      if (mode === "reopened") {
        view.trigger.click();
        await waitForSolid(() => expect(view.isOpen()).toBe(true));
      }
    }
    ready.resolve();
    await waitForSolid(() => expect(view.toggle()).toBeTruthy());
    view.expectTrigger();
    expect(loads).toBe(1);
    if (mode === "closed") {
      expect(view.isOpen()).toBe(false);
    } else if (mode === "external") {
      expect(document.activeElement).toBe(external);
    } else if (mode === "pointer") {
      expect(document.activeElement).toBe(view.trigger);
    } else {
      await waitForSolid(() =>
        expect(document.activeElement).toBe(
          mode === "last"
            ? view.toggle()
            : view.getByRole("menuitem", { name: "Take photo", hidden: true }),
        ),
      );
      view.toggle().click();
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
  expect(view.isOpen()).toBe(true);
  expect(view.getByRole("alert").textContent).toContain("Menu chunk could not be loaded");
  vi.doUnmock("./chat-composer-plus-menu-content.tsx");
  view.getByRole("button", { name: "Retry" }).click();
  await waitForSolid(() => expect(view.toggle("Original toggle")).toBeTruthy());
  view.expectTrigger();
  expect(view.isOpen()).toBe(true);
});
