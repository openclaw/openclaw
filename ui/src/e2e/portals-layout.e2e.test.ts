import type { PortalSummary } from "@openclaw/gateway-protocol";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
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
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const origin = new URL(suite.server.baseUrl).origin;
        const portalFixture = (id: string, title: string, port: number): PortalSummary => {
          const publicUrl = `${origin}/portals-close-fixture-${id}.html`;
          return {
            id,
            title,
            port,
            listenPort: port,
            tokenQuery: "openclaw_portal=synthetic",
            url: `${publicUrl}?openclaw_portal=synthetic`,
            publicUrl,
            createdAtMs: 1000,
          };
        };
        const first = portalFixture("app-0", "First app", 3000);
        const second = portalFixture("app-1", "Second app", 3001);
        const portals = [first, second];
        for (const portal of portals) {
          await page.route(`${portal.publicUrl}*`, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><title>${portal.title}</title><h1>${portal.title}</h1>`,
            }),
          );
        }
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "portal.close", "portal.list"],
          methodResponses: { "portal.list": { portals }, "portal.close": { closed: true } },
        });
        await page.goto(`${suite.server.baseUrl}portals`);
        await page.locator(".portals-preview__frame").waitFor();
        await gateway.deferNext("portal.close");
        await page.getByRole("button", { name: "Close First app", exact: true }).click();
        await gateway.waitForRequest("portal.close", { match: { id: first.id } });
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
        expect(await page.locator(".portals-preview__error").count()).toBe(0);
        await page.getByRole("button", { name: "First app" }).click();
        await page
          .getByText("Couldn’t close the portal. Try again. Synthetic first-app close failure", {
            exact: true,
          })
          .waitFor();
        await gateway.setMethodResponse("portal.list", { portals: [second] });
        await page.getByRole("button", { name: "Close First app", exact: true }).click();
        await gateway.waitForRequest("portal.close", { after: 1, match: { id: first.id } });
        expect((await gateway.getRequests("portal.close")).map(({ params }) => params)).toEqual([
          { id: first.id },
          { id: first.id },
        ]);
        await expect.poll(() => page.locator(".portals-preview__error").count()).toBe(0);
        await expect.poll(() => page.getByRole("button", { name: "First app" }).count()).toBe(0);
      },
    );
  });
  it("centers the device-ready status inside the embedded portal sheet", async () => {
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        viewport: { width: 820, height: 1180 },
        hasTouch: true,
      },
      async ({ page }) => {
        const sessionKey = "agent:main:portal-layout";
        const environmentId = "review-device";
        const gateway = await installMockGateway(page, {
          sessionKey,
          featureMethods: [...defaultControlUiFeatureMethods, "environments.status"],
          methodResponses: {
            "environments.status": { id: environmentId, type: "worker", status: "available" },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        await gateway.emitGatewayEvent("ui.command", {
          command: { kind: "panel", panel: "portal", open: true, environmentId },
          sessionKey,
        });
        const pane = page.locator("openclaw-portals-page[embedded]");
        const title = pane.getByText("Device ready. Waiting for your app…", { exact: true });
        await title.waitFor();
        // The opening sheet can move between separate browser protocol calls.
        const offset = await title.evaluate((message) => {
          const host = message.closest("openclaw-portals-page[embedded]");
          if (!host) {
            throw new Error("Missing portal status bounds");
          }
          const hostBounds = host.getBoundingClientRect();
          const messageBounds = message.getBoundingClientRect();
          if (
            !hostBounds.width ||
            !hostBounds.height ||
            !messageBounds.width ||
            !messageBounds.height
          ) {
            throw new Error("Missing portal status bounds");
          }
          return {
            x: Math.abs(
              messageBounds.x + messageBounds.width / 2 - hostBounds.x - hostBounds.width / 2,
            ),
            y: Math.abs(
              messageBounds.y + messageBounds.height / 2 - hostBounds.y - hostBounds.height / 2,
            ),
          };
        });
        expect(offset.x).toBeLessThanOrEqual(1);
        expect(offset.y).toBeLessThanOrEqual(1);
      },
    );
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
            const { top, bottom, left, right, height: boxHeight } = element.getBoundingClientRect();
            return { top, bottom, left, right, height: boxHeight };
          };
          const bounds = content.getBoundingClientRect(),
            style = getComputedStyle(content);
          return {
            contentInnerBottom: bounds.bottom - Number.parseFloat(style.paddingBottom),
            contentInnerLeft: bounds.left + Number.parseFloat(style.paddingLeft),
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
          for (const panel of [rail, preview]) {
            expect(Math.abs(panel.left - geometry.contentInnerLeft)).toBeLessThanOrEqual(1);
            expect(Math.abs(panel.right - geometry.contentInnerRight)).toBeLessThanOrEqual(1);
          }
        }
      },
    );
  });
});
