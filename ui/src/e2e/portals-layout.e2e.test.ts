import type { PortalSummary } from "@openclaw/gateway-protocol";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI Portals layout" });
suite.define(() => {
  it.each([
    ["tall", 1440, 1000],
    ["short", 1280, 520],
    ["narrow", 390, 844],
  ] as const)("preserves Portal geometry in a %s window", async (kind, width, height) => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width, height } },
      async ({ page }) => {
        const fixturePath = "/portals-layout-fixture.html",
          origin = new URL(suite.server.baseUrl).origin;
        const portal = {
          id: "p3000",
          title: "Seeded app",
          port: 3000,
          listenPort: 43_123,
          tokenQuery: "openclaw_portal=e2e",
          url: `${origin}${fixturePath}?openclaw_portal=e2e`,
          publicUrl: `${origin}${fixturePath}`,
          description: "Layout fixture app.",
          createdAtMs: 1_000,
        } satisfies PortalSummary;
        await page.route(`**${fixturePath}*`, (route) =>
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
        await page.goto(`${suite.server.baseUrl}portals`);
        await page.locator(".portals-rail").waitFor();
        await page.locator(".portals-preview__frame").waitFor();
        const geometry = await page.locator(".portals-layout").evaluate((layout) => {
          const content = layout.closest("main.content");
          const preview = layout.querySelector(".portals-preview");
          const frame = layout.querySelector(".portals-preview__frame");
          const rail = layout.querySelector(".portals-rail");
          if (!content || !preview || !frame || !rail) {
            throw new DOMException("Incomplete Portal layout", "DataError");
          }
          const box = (element: Element) => {
            const { top, bottom, right, height: boxHeight } = element.getBoundingClientRect();
            return { top, bottom, right, height: boxHeight };
          };
          const bounds = content.getBoundingClientRect(),
            style = getComputedStyle(content);
          return {
            contentInnerBottom: bounds.bottom - Number.parseFloat(style.paddingBottom),
            contentInnerRight: bounds.right - Number.parseFloat(style.paddingRight),
            contentScrollHeight: content.scrollHeight,
            contentClientHeight: content.clientHeight,
            gridTemplateColumns: getComputedStyle(layout).gridTemplateColumns,
            layout: box(layout),
            preview: box(preview),
            frame: box(frame),
            rail: box(rail),
          };
        });
        const { layout, preview, frame, rail } = geometry;
        if (kind === "tall") {
          expect(layout.height).toBeGreaterThan(720);
          expect(Math.abs(layout.bottom - geometry.contentInnerBottom)).toBeLessThanOrEqual(1);
          expect(geometry.contentScrollHeight).toBeLessThanOrEqual(
            geometry.contentClientHeight + 1,
          );
          expect(frame.height).toBeGreaterThan(720);
          expect(Math.abs(frame.bottom - preview.bottom)).toBeLessThanOrEqual(2);
        } else if (kind === "short") {
          expect(frame.height).toBeGreaterThanOrEqual(480);
          expect(frame.bottom).toBeLessThanOrEqual(preview.bottom + 2);
          expect(preview.bottom).toBeLessThanOrEqual(layout.bottom + 1);
          expect(geometry.contentScrollHeight).toBeGreaterThan(geometry.contentClientHeight);
        } else {
          expect(geometry.gridTemplateColumns.split(" ")).toHaveLength(1);
          expect(rail.bottom).toBeLessThanOrEqual(preview.top);
          expect(preview.height).toBeGreaterThanOrEqual(560);
          expect(preview.right).toBeLessThanOrEqual(geometry.contentInnerRight + 1);
        }
      },
    );
  });
});
