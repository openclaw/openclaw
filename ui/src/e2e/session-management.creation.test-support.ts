import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";

export async function openNestedSessionMenu(page: Page, parentKey: string) {
  const row = page.locator('[data-session-key="' + parentKey + '"]');
  await row.waitFor({ state: "visible" });
  await row.hover();
  await row.click({ button: "right" });
  const action = page.getByRole("menuitem", { name: "New child session", exact: true });
  await action.waitFor({ state: "visible", timeout: 10_000 });
  return { row, action };
}

export async function captureNestedSessionProof(
  page: Page,
  state: "menu" | "created" | "real-menu" | "real-created",
) {
  const prefix = process.env.OPENCLAW_CAPTURE_NESTED_PROOF;
  if (!prefix) {
    return;
  }
  const directory = new URL("../../../.openclaw/tmp/nested-session-proof/", import.meta.url);
  await mkdir(directory, { recursive: true });
  const filename = state.endsWith("menu") ? `${prefix}-${state}.png` : `after-${state}.png`;
  await page.screenshot({ path: fileURLToPath(new URL(filename, directory)) });
}
