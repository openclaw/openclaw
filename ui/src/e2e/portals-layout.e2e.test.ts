import path from "node:path";
import type { PortalSummary } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const FIXTURE_PATH = "/portals-layout-fixture.html";
// The preview frame owns a 480px floor and the header sits above it, so a
// standalone layout never shrinks below what the frame needs.
const PREVIEW_MIN_HEIGHT = 480;

const suite = createControlUiE2eSuite({
  name: "Control UI Portals layout",
  startServerBeforeBrowser: true,
  // Source server: the page stylesheet and its shell-content class are the change.
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});

async function openPortals(page: Page, baseUrl: string) {
  const origin = new URL(baseUrl).origin;
  const portal = {
    id: "p3000",
    title: "Seeded app",
    port: 3000,
    listenPort: 43_123,
    tokenQuery: "openclaw_portal=e2e",
    url: `${origin}${FIXTURE_PATH}?openclaw_portal=e2e`,
    publicUrl: `${origin}${FIXTURE_PATH}`,
    description: "Layout fixture app.",
    createdAtMs: 1_000,
  } satisfies PortalSummary;
  await page.route(`**${FIXTURE_PATH}*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<!doctype html><title>Portal fixture</title><body style="margin:0">portal</body>',
    }),
  );
  await installMockGateway(page, {
    featureMethods: [...defaultControlUiFeatureMethods, "portal.close", "portal.list"],
    methodResponses: { "portal.list": { portals: [portal] } },
  });
  await page.goto(`${baseUrl}portals`);
  await page.locator(".portals-rail").waitFor();
  await page.locator(".portals-preview__frame").waitFor();
}

type Box = { top: number; bottom: number; left: number; right: number; height: number };

function readLayout(page: Page) {
  return page.locator(".portals-layout").evaluate((layout) => {
    const content = layout.closest("main.content");
    const preview = layout.querySelector<HTMLElement>(".portals-preview");
    const frame = layout.querySelector<HTMLElement>(".portals-preview__frame");
    const rail = layout.querySelector<HTMLElement>(".portals-rail");
    if (!content || !preview || !frame || !rail) {
      throw new DOMException("Portals layout is missing its shell content or preview", "DataError");
    }
    const box = (element: Element) => {
      const { top, bottom, left, right, height } = element.getBoundingClientRect();
      return { top, bottom, left, right, height };
    };
    const contentBox = content.getBoundingClientRect();
    return {
      contentInnerBottom:
        contentBox.bottom - Number.parseFloat(getComputedStyle(content).paddingBottom),
      contentInnerRight:
        contentBox.right - Number.parseFloat(getComputedStyle(content).paddingRight),
      contentScrollHeight: content.scrollHeight,
      contentClientHeight: content.clientHeight,
      gridTemplateColumns: getComputedStyle(layout).gridTemplateColumns,
      layout: box(layout) as Box,
      preview: box(preview) as Box,
      frame: box(frame) as Box,
      rail: box(rail) as Box,
    };
  });
}

async function captureProof(page: Page, name: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const proofDir = createControlUiE2eArtifactDir(name);
  await page.screenshot({ path: path.join(proofDir, "portals.png"), animations: "disabled" });
}

suite.define(() => {
  it("fills the shell content height in a tall desktop window", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 1440, height: 1000 } },
      async ({ page }) => {
        await openPortals(page, suite.server.baseUrl);
        const layout = await readLayout(page);
        await captureProof(page, "portals-tall");

        // The 720px standalone cap used to end the page above the viewport bottom.
        expect(layout.layout.height).toBeGreaterThan(720);
        expect(Math.abs(layout.layout.bottom - layout.contentInnerBottom)).toBeLessThanOrEqual(1);
        expect(layout.contentScrollHeight).toBeLessThanOrEqual(layout.contentClientHeight + 1);
        expect(layout.frame.height).toBeGreaterThan(720);
        expect(Math.abs(layout.frame.bottom - layout.preview.bottom)).toBeLessThanOrEqual(2);
      },
    );
  });

  it("keeps the whole preview frame reachable in a short window", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 1280, height: 520 } },
      async ({ page }) => {
        await openPortals(page, suite.server.baseUrl);
        const layout = await readLayout(page);
        await captureProof(page, "portals-short");

        expect(layout.frame.height).toBeGreaterThanOrEqual(PREVIEW_MIN_HEIGHT);
        expect(layout.frame.bottom).toBeLessThanOrEqual(layout.preview.bottom + 2);
        expect(layout.preview.bottom).toBeLessThanOrEqual(layout.layout.bottom + 1);
        expect(layout.contentScrollHeight).toBeGreaterThan(layout.contentClientHeight);
      },
    );
  });

  it("keeps the rail above the preview in one column on a narrow window", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 390, height: 844 } },
      async ({ page }) => {
        await openPortals(page, suite.server.baseUrl);
        const layout = await readLayout(page);
        await captureProof(page, "portals-narrow");

        expect(layout.gridTemplateColumns.split(" ")).toHaveLength(1);
        expect(layout.rail.bottom).toBeLessThanOrEqual(layout.preview.top);
        expect(layout.preview.height).toBeGreaterThanOrEqual(560);
        expect(layout.preview.right).toBeLessThanOrEqual(layout.contentInnerRight + 1);
      },
    );
  });
});
