import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  mountMenu,
  openSubmenu,
  selectMenuValue,
  settleSessionMenu,
} from "../test-helpers/session-menu.ts";
import "../test-helpers/load-styles.ts";

it("dispatches compact archive with the existing A shortcut", async () => {
  await page.viewport(390, 844);
  const onAction = vi.fn();
  await mountMenu({ compact: true, onAction });
  const archive = page.getByText("Archive session", { exact: true });
  await expect.element(archive).toBeVisible();
  await userEvent.keyboard("a");
  expect(onAction).toHaveBeenCalledWith({ kind: "toggle-archived" });
});

it.each(["dispatch", "move", "retry"] as const)(
  "offers one %s placement action, respecting disabled and batch menus",
  async (placementAction) => {
    await page.viewport(1280, 900);
    const onAction = vi.fn();
    const menu = await mountMenu({ session: { placementAction }, onAction });
    const label =
      placementAction === "dispatch"
        ? "Move to cloud…"
        : placementAction === "retry"
          ? "Retry move"
          : "Move session…";
    const item = page.getByRole("menuitem", { name: label, exact: true });
    await expect.element(item).toBeVisible();
    menu.actionDisabledReasons = { "move-session": "Wait for the active turn to finish." };
    await menu.updateComplete;
    await expect.element(item).toBeDisabled();
    expect(onAction).not.toHaveBeenCalled();
    menu.actionDisabledReasons = {};
    await menu.updateComplete;
    await item.click();
    expect(onAction).toHaveBeenCalledWith({ kind: "move-session" });
    menu.selectionCount = 2;
    await menu.updateComplete;
    await expect.element(item).not.toBeInTheDocument();
  },
);
it("keeps compact custom snooze keyboard input inside its popover", async () => {
  await page.viewport(390, 844);
  const onAction = vi.fn();
  const menu = await mountMenu({ compact: true, snoozeAllowed: true, onAction });
  await selectMenuValue(menu, "compact:open-snooze");
  await page.getByText("Choose another time", { exact: true }).click();
  const field = page.getByLabelText("Date and time", { exact: true });
  const picker = menu.querySelector<HTMLElement>(".session-menu__snooze-picker")!;
  await expect.element(field).toHaveFocus();
  await userEvent.tab();
  await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toHaveFocus();
  await userEvent.tab();
  await expect.element(page.getByRole("button", { name: "Snooze", exact: true })).toHaveFocus();
  await userEvent.tab();
  await expect.element(field).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => picker.checkVisibility({ checkVisibilityCSS: true })).toBe(false);
  await expect
    .element(page.getByRole("menuitem", { name: "Choose another time", exact: true }))
    .toHaveFocus();
  await page.getByText("Choose another time", { exact: true }).click();
  await field.fill("2020-01-01T09:00");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Choose a date and time in the future.");
  expect(onAction).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => picker.checkVisibility({ checkVisibilityCSS: true })).toBe(false);
});

it("recreates the custom snooze picker when the menu opens at another anchor", async () => {
  const menu = await mountMenu({ snoozeAllowed: true });
  await openSubmenu(menu, "Snooze");
  await page.getByRole("menuitem", { name: "Choose another time", exact: true }).click();
  const field = page.getByLabelText("Date and time", { exact: true });
  await expect.element(field).toHaveFocus();
  const previous = menu.querySelector(".session-menu__snooze-picker");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  menu.anchor = { x: 200, y: 150 };
  await settleSessionMenu(menu);
  await openSubmenu(menu, "Snooze");
  await page.getByRole("menuitem", { name: "Choose another time", exact: true }).click();
  await expect.element(field).toHaveFocus();
  expect(menu.querySelector(".session-menu__snooze-picker")).not.toBe(previous);
});
