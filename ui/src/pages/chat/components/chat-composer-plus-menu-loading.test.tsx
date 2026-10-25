/* @vitest-environment jsdom */
import { createSignal, type Setter } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createChatAttachmentInputHandle } from "./chat-attachment-inputs.ts";
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
    const [menu, update] = createSignal<ChatComposerPlusMenuProps>({
      attachments: {},
      inputHandle: createChatAttachmentInputHandle(),
      disabled: false,
      open: false,
      view: "root",
      toolOverrides: null,
      rootToggles: [
        { value: "toggle", label: "Original toggle", checked: false, disabled: false, onChange },
      ],
      onOpenChange: (open) => update((current) => ({ ...current, open })),
      onViewChange: vi.fn(),
    });
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
  return { ...view, setMenu, trigger, panel, onChange };
}

it.each(["keyboard", "last", "pointer", "external", "closed", "reopened"] as const)(
  "keeps the trigger and respects %s focus while menu content loads",
  async (mode) => {
    const entered = createDeferred();
    const imported = createDeferred();
    const ready = createDeferred();
    onTestFinished(() => ready.resolve());
    let loads = 0;
    vi.doMock("./chat-composer-plus-menu-content.tsx", async () => {
      loads++;
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
      view.trigger.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: mode === "last" ? "ArrowUp" : "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    // Cold module work precedes Solid's DOM settlement window.
    await entered.promise;
    await waitForSolid(() => {
      expect(view.panel.matches(":popover-open")).toBe(true);
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
      await waitForSolid(() => expect(view.panel.matches(":popover-open")).toBe(false));
      if (mode === "reopened") {
        view.trigger.click();
        await waitForSolid(() => expect(view.panel.matches(":popover-open")).toBe(true));
      }
    }
    ready.resolve();
    await imported.promise;
    await waitForSolid(() =>
      expect(
        view.getByRole("menuitemcheckbox", { name: "Updated toggle", hidden: true }),
      ).toBeTruthy(),
    );
    expect(view.container.querySelector(".agent-chat__input-btn--attach")).toBe(view.trigger);
    expect(loads).toBe(1);
    if (mode === "closed") {
      expect(view.panel.matches(":popover-open")).toBe(false);
    } else if (mode === "external") {
      expect(document.activeElement).toBe(external);
    } else if (mode === "pointer") {
      expect(document.activeElement).toBe(view.trigger);
    } else {
      await waitForSolid(() =>
        expect(document.activeElement).toBe(
          mode === "last"
            ? view.getByRole("menuitemcheckbox", { name: "Updated toggle", hidden: true })
            : view.getByRole("menuitem", { name: "Take photo", hidden: true }),
        ),
      );
      if (mode === "keyboard") {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
        );
        await waitForSolid(() =>
          expect(document.activeElement).toBe(
            view.getByRole("menuitemcheckbox", { name: "Updated toggle", hidden: true }),
          ),
        );
      }
      view.getByRole("menuitemcheckbox", { name: "Updated toggle", hidden: true }).click();
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
  await waitForSolid(() =>
    expect(
      view.getByRole("menuitemcheckbox", { name: "Original toggle", hidden: true }),
    ).toBeTruthy(),
  );
  expect(view.container.querySelector(".agent-chat__input-btn--attach")).toBe(view.trigger);
  expect(view.panel.matches(":popover-open")).toBe(true);
});
