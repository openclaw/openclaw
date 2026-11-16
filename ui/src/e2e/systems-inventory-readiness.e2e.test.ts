import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({ name: "Systems first inventory audit" });
suite.define(() => {
  it.each([1280, 390])(
    "keeps failed inventory distinct from empty and unmatched devices at %ipx",
    (width) =>
      suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["environments.list", "node.list", "system.info", "backup.status"],
          deferredMethods: ["environments.list"],
          methodResponses: {
            "environments.list": { environments: [] },
            "node.list": { nodes: [] },
            "system.info": {
              machineName: "Synthetic Gateway",
              platform: "linux",
              release: "test",
              arch: "x64",
              osLabel: "Linux",
              nodeVersion: "v24",
              pid: 1,
              uptimeMs: 1000,
            },
            "backup.status": { targets: [], schedules: [], locations: [] },
          },
        });
        await page.goto(suite.server.baseUrl + "systems");
        await gateway.waitForRequest("environments.list");
        if (width === 390) {
          await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
        }
        const sidebar = page.locator(".systems-sidebar");
        const search = sidebar.getByRole("searchbox", { name: "Find a device…", exact: true });
        await search.waitFor();
        expect(await sidebar.getByText("No devices yet.", { exact: true }).count()).toBe(0);
        await gateway.rejectDeferred("environments.list", {
          message: "Synthetic device inventory unavailable",
        });
        await page
          .locator(".systems-callout--error")
          .filter({ hasText: "Synthetic device inventory unavailable" })
          .waitFor();
        await expect
          .poll(() => sidebar.locator(".systems-sidebar__list").getAttribute("aria-busy"))
          .toBe("false");
        expect
          .soft(
            await sidebar.getByText("No devices yet.", { exact: true }).count(),
            "failed read is not accepted empty inventory",
          )
          .toBe(0);
        if (width === 1280) {
          expect.soft(await page.locator(".systems-heading").isVisible()).toBe(false);
          expect
            .soft(
              await page.locator(".systems-desktop .systems-state").isVisible(),
              "an unknown inventory cannot offer a device to choose",
            )
            .toBe(false);
        }
        await search.fill("fleet");
        expect
          .soft(
            await sidebar.getByText("No devices match your search.", { exact: true }).count(),
            "unknown membership cannot establish no matches",
          )
          .toBe(0);
        await search.fill("");
        if (width === 1280 && process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const file = suite.artifactDir + "/first-inventory-failed.png";
          await page.screenshot({ path: file });
          console.log("Systems inventory capture: " + file);
        }
        await gateway.deferNext("environments.list");
        await sidebar.getByRole("button", { name: "Refresh devices", exact: true }).click();
        await expect
          .poll(async () => (await gateway.getRequests("environments.list")).length)
          .toBe(2);
        expect(await sidebar.getByText("No devices yet.", { exact: true }).count()).toBe(0);
        await gateway.resolveDeferred("environments.list", {
          environments: [
            {
              id: "node:recovered",
              type: "node",
              label: "Recovered fleet",
              status: "available",
              desktop: false,
              capabilities: [],
            },
          ],
        });
        await sidebar.getByRole("button", { name: "Recovered fleet", exact: true }).waitFor();
        await search.fill("not-present");
        await sidebar.getByText("No devices match your search.", { exact: true }).waitFor();
        await search.fill("");
        await gateway.setMethodResponse("environments.list", { environments: [] });
        await sidebar.getByRole("button", { name: "Refresh devices", exact: true }).click();
        await sidebar.getByText("No devices yet.", { exact: true }).waitFor();
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
      }),
  );
});
