import type { Locator } from "playwright";

async function openFileActions(panel: Locator): Promise<Locator> {
  const trigger = panel
    .getByRole("button", { name: /^(More file actions|File actions)$/ })
    .filter({ visible: true });
  await trigger.waitFor();
  const label = await trigger.getAttribute("aria-label");
  if (!label) {
    throw new Error("The file actions trigger must label its menu");
  }
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  const menu = panel.getByRole("menu", { name: label, exact: true });
  await menu.and(panel.locator('[data-phase="open"]')).waitFor();
  return menu;
}

export async function selectFileAction(panel: Locator, name: string): Promise<void> {
  const direct = panel.getByRole("button", { name, exact: true }).filter({ visible: true });
  if (await direct.isVisible()) {
    await direct.click();
    return;
  }
  const menu = await openFileActions(panel);
  await menu
    .getByRole("menuitem", { name, exact: true })
    .or(menu.getByRole("menuitemcheckbox", { name, exact: true }))
    .or(menu.getByRole("menuitemradio", { name, exact: true }))
    .click();
}
