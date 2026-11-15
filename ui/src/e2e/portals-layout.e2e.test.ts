import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { PortalSummary } from "@openclaw/gateway-protocol";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
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
  it("keeps close failures with their selected portal", async () => {
    const apps = ["First app", "Second app"].map((title) =>
      createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(
          `<!doctype html><title>${title}</title><h1>${title}</h1><p>Owned loopback fixture</p>`,
        );
      }),
    );
    await Promise.all(
      apps.map(
        (app) =>
          new Promise<void>((resolve) => {
            app.listen(0, "127.0.0.1", resolve);
          }),
      ),
    );
    const portals: PortalSummary[] = apps.map((app, index) => {
      const address = app.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing app port");
      }
      const publicUrl = `http://127.0.0.1:${address.port}/`;
      return {
        id: `app-${index}`,
        title: index === 0 ? "First app" : "Second app",
        port: address.port,
        listenPort: address.port,
        tokenQuery: "openclaw_portal=synthetic",
        url: `${publicUrl}?openclaw_portal=synthetic`,
        publicUrl,
        createdAtMs: 1000,
      };
    });
    try {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            featureMethods: [...defaultControlUiFeatureMethods, "portal.close", "portal.list"],
            methodResponses: { "portal.list": { portals }, "portal.close": { closed: true } },
          });
          await page.goto(`${suite.server.baseUrl}portals`);
          await page.locator(".portals-preview__frame").waitFor();
          await gateway.deferNext("portal.close");
          await page.getByRole("button", { name: "Close First app", exact: true }).click();
          await gateway.waitForRequest("portal.close");
          await gateway.rejectDeferred("portal.close", {
            message: "Synthetic first-app close failure",
          });
          await page
            .getByText("Couldn’t close the portal. Try again. Synthetic first-app close failure", {
              exact: true,
            })
            .waitFor();
          await page.getByRole("button", { name: "Second app" }).click();
          await page
            .frameLocator(".portals-preview__frame")
            .getByRole("heading", { name: "Second app" })
            .waitFor();
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".portals-layout"),
            [page.locator(".portals-rail"), page.locator(".portals-preview__frame")],
            { animations: "disabled" },
          );
          await writeFile(join(suite.artifactDir, "close-error-selection.png"), frame.png);
          expect(await page.locator(".portals-preview__error").count()).toBe(0);
          await page.getByRole("button", { name: "First app" }).click();
          await page
            .getByText("Couldn’t close the portal. Try again. Synthetic first-app close failure", {
              exact: true,
            })
            .waitFor();
          await gateway.setMethodResponse("portal.list", { portals: [portals[1]] });
          await page.getByRole("button", { name: "Close First app", exact: true }).click();
          await expect.poll(async () => (await gateway.getRequests("portal.close")).length).toBe(2);
          await expect.poll(() => page.locator(".portals-preview__error").count()).toBe(0);
          await expect.poll(() => page.getByRole("button", { name: "First app" }).count()).toBe(0);
        },
      );
    } finally {
      await Promise.all(
        apps.map(
          (app) =>
            new Promise<void>((resolve, reject) => {
              app.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
      );
    }
  });
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
