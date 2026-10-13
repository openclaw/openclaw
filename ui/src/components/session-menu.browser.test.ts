import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountMenu, selectMenuValue } from "../test-helpers/session-menu.ts";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "../test-helpers/load-styles.ts";

it("opens the compact archive choices with the existing A shortcut", async () => {
  await page.viewport(390, 844);
  await mountMenu({ compact: true, session: { hasChildren: true } });
  const archive = page.getByText("Archive session", { exact: true });
  await expect.element(archive).toBeVisible();
  await userEvent.keyboard("a");
  await expect.element(page.getByText("Session only", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("Archive session and children…", { exact: true }))
    .toBeVisible();
  await page.getByText("Back", { exact: true }).click();
  await expect.element(archive).toBeVisible();
});

it("keeps compact custom snooze keyboard input inside its popover", async () => {
  await page.viewport(390, 844);
  const onAction = vi.fn();
  const menu = await mountMenu({ compact: true, snoozeAllowed: true, onAction });
  selectMenuValue(menu, "compact:open-snooze");
  await page.getByText("Choose another time", { exact: true }).click();
  const field = page.getByLabelText("Date and time", { exact: true });
  const picker = page.elementLocator(
    menu.querySelector<HTMLElement>(".session-menu__snooze-picker")!,
  );
  await expect.element(field).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(picker).not.toBeVisible();
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
  await expect.element(picker).not.toBeVisible();
});
