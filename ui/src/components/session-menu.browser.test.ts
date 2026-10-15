import { expect, it, onTestFinished, vi } from "vitest";
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

async function openIconSubmenu(onAction = vi.fn()) {
  await page.viewport(1280, 800);
  await mountMenu({ onAction });
  const outside = document.createElement("div");
  outside.style.cssText = "position:fixed;right:0;bottom:0;width:40px;height:40px";
  document.body.append(outside);
  onTestFinished(() => outside.remove());
  await userEvent.hover(outside);
  await page.getByText("Advanced", { exact: true }).hover();
  await page.getByText("Icon & color", { exact: true }).hover();
  // Opening settles once the picker moves focus to its first color.
  await expect.element(page.getByRole("button", { name: "No color", exact: true })).toHaveFocus();
  return outside;
}

it("keeps custom icon entry open while the pointer is in the system emoji viewer", async () => {
  const onAction = vi.fn();
  const outside = await openIconSubmenu(onAction);
  await page.getByRole("button", { name: "Custom icon…", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Custom icon", exact: true });
  await expect.element(field).toHaveFocus();
  // The viewer inserts text while the pointer is over its OS window, outside the submenu.
  await field.fill("🦀");
  // Web Awesome closes a hover-left submenu 100 ms after the pointer moves away.
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    await userEvent.hover(outside);
    vi.advanceTimersByTime(150);
  } finally {
    vi.useRealTimers();
  }
  await expect
    .element(page.getByRole("menuitem", { name: "Icon & color", exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  await expect.element(field).toBeVisible();
  await expect.element(field).toHaveValue("🦀");
  await page.getByRole("button", { name: "Set", exact: true }).click();
  expect(onAction).toHaveBeenCalledWith({ kind: "set-icon", icon: "🦀" });
});

it("still closes the icon submenu when the pointer leaves without text entry", async () => {
  const outside = await openIconSubmenu();
  const item = page.getByRole("menuitem", { name: "Icon & color", exact: true });
  await expect.element(item).toHaveAttribute("aria-expanded", "true");
  await userEvent.hover(outside);
  await expect.element(item).toHaveAttribute("aria-expanded", "false");
});
