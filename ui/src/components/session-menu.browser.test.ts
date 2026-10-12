import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountMenu } from "../test-helpers/session-menu.ts";
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
