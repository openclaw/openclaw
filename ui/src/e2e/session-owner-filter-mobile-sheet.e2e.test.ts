import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { settleSidebarMenuMotion } from "./sidebar-session-menu.test-support.ts";

const suite = createSessionManagementE2eSuite();
const unlabeledOwner = "profile-1bdc4000-c099-4221-bdc4-a62446dbbf92";
const longOwner = "Christopher Alexander Montgomery-Eckert (ceckert)";

suite.define(() => {
  it("shows the phone owner page as a rounded card with single-line faded names", () =>
    suite.withPage(
      { reducedMotion: "reduce", viewport: { height: 844, width: 390 } },
      async ({ page }) => {
        const key = "agent:main:owner-sheet";
        await installMockGateway(page, {
          sessionKey: key,
          methodResponses: {
            "sessions.list": {
              ...sessionsListResponse([sessionRow(key, "Owner sheet", Date.now())]),
              owners: [
                { type: "human", id: unlabeledOwner },
                { type: "human", id: "profile-ada", label: "Ada" },
                { type: "human", id: "profile-long", label: longOwner },
              ],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        await page.getByRole("button", { name: "Expand sidebar" }).click();
        await page.locator("#sidebar-session-owner-title").click();
        const list = page.getByRole("listbox", { name: "Owners", exact: true });
        await settleSidebarMenuMotion(list);
        const menu = page.locator(".sidebar-session-owner-filter .picker-select__menu");
        await expectBrowser(menu).toBeVisible();

        const surface = await menu.evaluate((element) => {
          const style = getComputedStyle(element);
          return { radius: Number.parseFloat(style.borderTopLeftRadius), shadow: style.boxShadow };
        });
        expect(surface.radius).toBeGreaterThan(0);
        expect(surface.shadow).not.toBe("none");
        // A short roster hugs its rows instead of stretching to the drawer's height.
        const card = await menu.boundingBox();
        expect(card!.height).toBeLessThan(844 / 2);

        const options = list.getByRole("option");
        await expectBrowser(options).toHaveCount(5);
        const rows = await options.evaluateAll((elements) =>
          elements.map((option) => {
            const label = option.querySelector<HTMLElement>(".picker-select__label")!;
            const style = getComputedStyle(label);
            return {
              text: label.textContent,
              lines: Math.round(
                label.getBoundingClientRect().height / Number.parseFloat(style.lineHeight),
              ),
              clipped: label.scrollWidth > label.clientWidth,
              ellipsis: style.textOverflow,
              mask: style.maskImage,
            };
          }),
        );
        for (const row of rows) {
          expect(row, row.text ?? "").toMatchObject({ lines: 1, ellipsis: "clip" });
          expect(row.mask, row.text ?? "").toContain("linear-gradient");
        }
        expect(rows.filter((row) => row.clipped).map((row) => row.text)).toEqual([
          unlabeledOwner,
          longOwner,
        ]);
      },
    ));
});
