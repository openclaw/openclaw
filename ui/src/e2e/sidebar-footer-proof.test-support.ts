import path from "node:path";
import type { Locator, Page } from "playwright";
import type { ControlUiBuildInfo } from "../build-info.ts";
import {
  installMockGateway,
  startControlUiE2eServer,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectAttribute } from "./sidebar-assertions.test-support.ts";

const SIDEBAR_PROOF_USER = {
  self: true,
  id: "riley",
  name: "Riley",
  email: "riley.with.a.deliberately.long.address@example.test",
} as const;

export function createSidebarFooterProofSuite(name: string, buildInfo?: ControlUiBuildInfo) {
  return createControlUiE2eSuite({
    name,
    browserLaunchOptions: { headless: process.env.OPENCLAW_UI_E2E_HEADED !== "1" },
    startServer: buildInfo ? () => startControlUiE2eServer(buildInfo, { source: true }) : undefined,
    startServerBeforeBrowser: true,
    trackBrowserContexts: true,
    unavailableMessage: (executablePath) =>
      `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
  });
}

export async function openSidebarFooterProofPage(
  suite: ReturnType<typeof createSidebarFooterProofSuite>,
  scenario: ControlUiMockGatewayScenario = {},
) {
  const context = await suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    presenceUsers: [SIDEBAR_PROOF_USER],
    ...scenario,
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  const sidebar = page.locator("openclaw-app-sidebar");
  await sidebar.locator(".sidebar-identity-card").waitFor();
  return { context, gateway, page, sidebar };
}

export async function setSidebarProofTheme(page: Page, mode: "dark" | "light") {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextMode;
    root.dataset.themeResolved = nextMode;
    root.style.colorScheme = nextMode;
  }, mode);
  await expectAttribute(page.locator("html"), "data-theme-mode", mode);
}

export async function captureUnionProof(
  owner: { readonly artifactDir: string },
  page: Page,
  directory: string,
  fileName: string,
  locators: readonly Locator[],
) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const locator of locators) {
    await locator.waitFor({ state: "visible" });
    await locator.evaluate(async (element) => {
      const running = element
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation.playState === "running" &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime),
        );
      await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
    });
    const box = await locator.boundingBox();
    if (!box) {
      throw new Error(`Cannot capture ${fileName}: a proof surface has no bounding box`);
    }
    boxes.push(box);
  }
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error(`Cannot capture ${fileName}: viewport is unavailable`);
  }
  const extent = (axis: "x" | "y", size: "width" | "height"): [number, number] => [
    Math.max(0, Math.min(...boxes.map((box) => box[axis])) - 12),
    Math.min(viewport[size], Math.max(...boxes.map((box) => box[axis] + box[size])) + 12),
  ];
  const [x, right] = extent("x", "width");
  const [y, bottom] = extent("y", "height");
  await page.screenshot({
    animations: "disabled",
    clip: { x, y, width: right - x, height: bottom - y },
    path: path.join(owner.artifactDir, directory, fileName),
  });
}
