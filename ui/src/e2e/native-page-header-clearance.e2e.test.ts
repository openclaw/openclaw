// Every non-chat page header is one toolbar row: title (or hub tabs) centered
// like a window title, actions at the trailing edge. Native macOS hosts put the
// traffic lights and hosted titlebar buttons in that row once the sidebar
// collapses, so the row must share their centerline instead of sliding under.
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI page toolbar row E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const proofDirParent = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
let proofDir: string | undefined;
let context: BrowserContext | undefined;
beforeEach(() => {
  proofDir = proofDirParent
    ? createControlUiE2eArtifactDir("page-toolbar-row", proofDirParent)
    : undefined;
});

type Box = { x: number; y: number; width: number; height: number };
const centerY = (box: Box) => box.y + box.height / 2;
const centerX = (box: Box) => box.x + box.width / 2;

suite.define(() => {
  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  async function openPage(
    route: string,
    install?: (page: Page) => Promise<void>,
    ready = ".content .content-header .page-title",
  ): Promise<Page> {
    context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await install?.(page);
    await installMockGateway(page);
    await page.goto(`${suite.server.baseUrl}${route}`);
    await page.locator(ready).first().waitFor({ state: "attached" });
    return page;
  }

  async function collapseNative(page: Page): Promise<Box> {
    const toolbar = page.locator(".macos-titlebar-controls");
    await toolbar.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-collapsed");
    const box = await toolbar.boundingBox();
    expect(box).not.toBeNull();
    return box!;
  }

  // The shell grid and header padding animate after a collapse, so geometry
  // checks poll until the row settles.
  async function expectOnCenterline(target: ReturnType<Page["locator"]>, center: number) {
    await expect
      .poll(async () => {
        const box = await target.boundingBox();
        return box ? Math.abs(centerY(box) - center) : Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(0.5);
  }

  async function expectCenteredIn(
    target: ReturnType<Page["locator"]>,
    container: ReturnType<Page["locator"]>,
  ) {
    await expect
      .poll(async () => {
        const [box, outer] = await Promise.all([target.boundingBox(), container.boundingBox()]);
        return box && outer ? Math.abs(centerX(box) - centerX(outer)) : Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(1);
  }

  it("centers the title in the Mac titlebar row and keeps actions beside it", async () => {
    const page = await openPage("agents", installNativeWebChrome);
    const toolbar = await collapseNative(page);
    expect(toolbar.y + toolbar.height).toBe(52);
    const header = page.locator(".content .content-header").first();
    const title = header.locator(".page-title");
    if (proofDir) {
      await page.screenshot({
        animations: "disabled",
        path: path.join(proofDir, "native-web-collapsed-page-header.png"),
      });
    }
    await expectOnCenterline(title, centerY(toolbar));
    await expectCenteredIn(title, header);
    const titleBox = (await title.boundingBox())!;
    expect(titleBox.x).toBeGreaterThan(toolbar.x + toolbar.width);
    const buttons = header.locator(".page-header-actions .btn");
    expect(await buttons.count()).toBeGreaterThan(0);
    for (let index = 0; index < (await buttons.count()); index += 1) {
      await expectOnCenterline(buttons.nth(index), centerY(toolbar));
      const box = (await buttons.nth(index).boundingBox())!;
      expect(box.x).toBeGreaterThan(titleBox.x + titleBox.width);
    }
    // The subtitle stays as intro text under the row.
    const subtitle = header.locator(".page-subtitle");
    expect((await subtitle.boundingBox())!.y).toBeGreaterThanOrEqual(52);
  });

  it("puts hub tabs in the row instead of a redundant title", async () => {
    const page = await openPage("sessions", installNativeWebChrome, ".hub-page-header__tabs");
    const toolbar = await collapseNative(page);
    const header = page.locator(".content .content-header.hub-page-header");
    // The heading stays for assistive tech but takes no visible space.
    const titleBox = (await header.locator(".page-title").boundingBox())!;
    expect(Math.max(titleBox.width, titleBox.height)).toBeLessThanOrEqual(1);
    const tabs = header.locator(".hub-page-header__tabs");
    await expectOnCenterline(tabs, centerY(toolbar));
    await expectCenteredIn(tabs, header);
    const tabsBox = (await tabs.boundingBox())!;
    expect(tabsBox.x).toBeGreaterThan(toolbar.x + toolbar.width);
  });

  it("keeps RTL page actions clear of the fixed left controls", async () => {
    // Arabic and Persian set the document direction (i18n/lib/translate.ts);
    // the collapsed-sidebar cluster stays fixed at the physical left either way.
    const page = await openPage("agents");
    await page.evaluate(() => {
      document.documentElement.dir = "rtl";
    });
    await page.locator(".sidebar-brand__collapse").click();
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-collapsed");
    const header = page.locator(".content .content-header").first();
    const title = header.locator(".page-title");
    await expectOnCenterline(title, 26);
    await expectCenteredIn(title, header);
    const controls = header.page().locator(".shell-chrome-controls button:visible");
    const controlRight = Math.max(
      ...(await controls.evaluateAll((buttons) =>
        buttons.map((button) => button.getBoundingClientRect().right),
      )),
    );
    const titleBox = (await title.boundingBox())!;
    const buttons = header.locator(".page-header-actions .btn");
    expect(await buttons.count()).toBeGreaterThan(0);
    for (let index = 0; index < (await buttons.count()); index += 1) {
      await expectOnCenterline(buttons.nth(index), 26);
      const box = (await buttons.nth(index).boundingBox())!;
      // Actions sit at the physical right, past the title, never under the cluster.
      expect(box.x).toBeGreaterThan(titleBox.x + titleBox.width);
      expect(box.x).toBeGreaterThan(controlRight);
    }
  });

  it("keeps the legacy Mac app's lowered web controls clear of intro text", async () => {
    // Older apps stamp only openclaw-native-macos and keep the in-page
    // cluster, which drops below the drag region instead of into a titlebar.
    const page = await openPage("agents", async (target) => {
      await target.addInitScript(() => {
        const stamp = () => document.documentElement.classList.add("openclaw-native-macos");
        if (document.documentElement) {
          stamp();
        } else {
          document.addEventListener("DOMContentLoaded", stamp);
        }
      });
    });
    await page.locator(".sidebar-brand__collapse").click();
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-collapsed");
    const controls = (await page.locator(".shell-chrome-controls").boundingBox())!;
    expect(controls.y + controls.height).toBeGreaterThan(52);
    const header = page.locator(".content .content-header").first();
    await expectOnCenterline(header.locator(".page-title"), 25);
    await expect
      .poll(async () => (await header.locator(".page-subtitle").boundingBox())?.y ?? -1)
      .toBeGreaterThanOrEqual(controls.y + controls.height);
  });
});
