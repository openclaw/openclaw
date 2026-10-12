import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import {
  takeControlUiElementScreenshot,
  takeControlUiViewportScreenshot,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export function createSidebarCustomizationSuite(name: string) {
  return createControlUiE2eSuite({
    name,
    trackBrowserContexts: true,
    unavailableMessage: (executablePath) =>
      `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
  });
}

export async function captureSidebarUiProof(
  owner: { readonly artifactDir: string },
  page: Page,
  fileName: string,
  surface?: Locator,
  content?: readonly Locator[],
): Promise<void> {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  if (page.video()) {
    const proofSurface = surface ?? page.locator(".shell");
    await writeFile(
      path.join(owner.artifactDir, fileName),
      await takeControlUiViewportScreenshot(page, proofSurface, content ?? [proofSurface]),
    );
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(owner.artifactDir, fileName),
  });
}

export async function captureSettingsSidebarUiProof(
  owner: { readonly artifactDir: string },
  sidebar: Locator,
  fileName: string,
): Promise<void> {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  if (sidebar.page().video()) {
    await writeFile(
      path.join(owner.artifactDir, fileName),
      await takeControlUiElementScreenshot(sidebar.page(), sidebar, [
        sidebar.getByRole("searchbox", { name: "Search settings" }),
      ]),
    );
    return;
  }
  await sidebar.screenshot({
    animations: "disabled",
    path: path.join(owner.artifactDir, fileName),
  });
}

export async function openSidebarCustomizationPage(
  suite: ReturnType<typeof createSidebarCustomizationSuite>,
) {
  const context = await suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();
  await installMockGateway(page);
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.locator("openclaw-app-sidebar").waitFor();
  const pages = await openSidebarPages(page);
  for (const label of ["Agents", "Dashboards", "Systems"]) {
    await pages
      .locator(".sidebar-pages__entry")
      .filter({ has: page.getByRole("link", { name: label, exact: true }) })
      .getByRole("button", { name: "Pin", exact: true })
      .click();
  }
  await page
    .locator("openclaw-app-sidebar")
    .getByRole("button", { name: "Sessions", exact: true })
    .click();
  return { context, page };
}

export async function openSidebarPages(page: Page): Promise<Locator> {
  const sidebar = page.locator("openclaw-app-sidebar:visible");
  const pages = sidebar.locator(".sidebar-pages");
  if (!(await pages.isVisible())) {
    await sidebar.getByRole("button", { name: "Pages", exact: true }).click();
  }
  await pages.waitFor();
  return pages;
}

export async function openSidebarPinMenu(page: Page, entry = "route:dashboards"): Promise<Locator> {
  const row = page
    .locator("openclaw-app-sidebar:visible")
    .locator(`[data-sidebar-entry="${entry}"]`);
  await row.locator("a, button").first().click({ button: "right" });
  const menu = page.locator("wa-dropdown.sidebar-rail-pin-menu");
  await menu.getByRole("menuitem", { name: "Unpin", exact: true }).waitFor();
  return menu;
}
