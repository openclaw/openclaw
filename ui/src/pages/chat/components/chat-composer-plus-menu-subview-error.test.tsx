/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { makeCapabilities, makeMenu } from "./chat-composer-menu.test-support.ts";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";

afterEach(() => vi.doUnmock("./chat-composer-plus-menu-subview.tsx"));

it("keeps root actions available after a capability chunk fails and retries the subview", async () => {
  // mock-isolation: reject the lazy import itself to exercise chunk-load recovery.
  vi.doMock("./chat-composer-plus-menu-subview.tsx", () => {
    throw new Error("Capability chunk could not be loaded");
  });
  const onChange = vi.fn();
  const view = mountSolid(() => {
    const [menu, update] = createSignal(
      makeMenu({
        capabilityMenu: makeCapabilities(),
        rootToggles: [
          { value: "toggle", label: "Root toggle", checked: false, disabled: false, onChange },
        ],
        onOpenChange: (open) => update((current) => ({ ...current, open, view: "root" })),
        onViewChange: (next) => update((current) => ({ ...current, view: next })),
      }),
    );
    return <ChatComposerPlusMenu menu={menu()} />;
  });
  const trigger = view.container.querySelector<HTMLButtonElement>(
    ".agent-chat__input-btn--attach",
  )!;
  const panel = view.container.querySelector(".agent-chat__capability-menu-panel")!;
  const rootToggle = () =>
    view.getByRole("menuitemcheckbox", { name: "Root toggle", hidden: true });
  const openSkills = () => view.getByRole("menuitem", { name: "Skills", hidden: true }).click();
  trigger.click();
  await waitForSolid(() => expect(rootToggle()).toBeTruthy());
  openSkills();
  await waitForSolid(() => expect(view.getByRole("alert")).toBeTruthy());
  expect(view.getByRole("alert").textContent).toContain("Capability chunk could not be loaded");
  view
    .getByRole("button", { name: "Retry" })
    .dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(false));
  trigger.click();
  await waitForSolid(() => expect(rootToggle()).toBeTruthy());
  rootToggle().click();
  expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  openSkills();
  await waitForSolid(() => expect(view.getByRole("alert")).toBeTruthy());
  vi.doUnmock("./chat-composer-plus-menu-subview.tsx");
  view.getByRole("button", { name: "Retry" }).click();
  await waitForSolid(() =>
    expect(view.getByRole("menuitem", { name: "Manage skills", hidden: true })).toBeTruthy(),
  );
  expect(panel.matches(":popover-open")).toBe(true);
});
