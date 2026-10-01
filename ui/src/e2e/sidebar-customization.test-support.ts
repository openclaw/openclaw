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
  return { context, page };
}

export async function openSidebarMoreMenu(page: Page): Promise<Locator> {
  const sidebar = page.locator("openclaw-app-sidebar");
  // Under load, Playwright can sample a stable frame while the scale-in animation
  // still moves items between pointer-down and pointer-up. Arm before opening.
  const transition = await sidebar.evaluateHandle((element) => {
    const controller = new AbortController();
    const shown = new Promise<void>((resolve) => {
      element.addEventListener(
        "wa-after-show",
        (event) => {
          if (
            event.target instanceof Element &&
            event.target.matches("wa-dropdown.sidebar-more-menu")
          ) {
            controller.abort();
            resolve();
          }
        },
        { signal: controller.signal },
      );
    });
    return { shown, dispose: () => controller.abort() };
  });
  try {
    await sidebar.locator(".sidebar-nav__head-action").click();
    await transition.evaluate(({ shown }) => shown);
  } finally {
    await transition.evaluate(({ dispose }) => dispose());
    await transition.dispose();
  }
  return sidebar.locator("wa-dropdown.sidebar-more-menu");
}
