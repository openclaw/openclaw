import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Devices confirmation recovery" });

suite.define(() => {
  it("reports failed confirmation preparation and releases other device actions", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 960 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "device.pair.list": {
            pending: [],
            paired: [
              { deviceId: "synthetic-device", displayName: "Office browser", roles: ["operator"] },
            ],
          },
          "node.list": { nodes: [] },
        },
      });
      await page.goto(suite.server.baseUrl + "settings/devices");
      await waitForControlUiRoute(page, { pathname: "/settings/devices", routeId: "devices" });
      const row = page.locator("details.device-entry").filter({ hasText: "Office browser" });
      await row.locator("summary").click();
      const module = controlUiE2eBuiltModuleRequest("ui/src/components/confirm-dialog-view.tsx");
      await page.route(module, (route) => route.abort("failed"));
      const failedModule = page.waitForEvent("requestfailed", (request) =>
        module.test(request.url()),
      );
      await row.locator('[data-device-action="remove"]').click();
      await failedModule;
      await expect.poll(() => page.locator("openclaw-devices-page [role=alert]").count()).toBe(1);
      const frame = await takeControlUiScreenshotFrame(
        page,
        page.locator("openclaw-devices-page"),
        [row],
        { animations: "disabled" },
      );
      await writeFile(path.join(suite.artifactDir, "confirmation-error.png"), frame.png);
      expect(await gateway.getRequests("device.pair.remove")).toHaveLength(0);
      await row.getByRole("button", { name: "Edit alias", exact: true }).click();
      await page.getByRole("dialog").getByRole("textbox").waitFor();
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await row.getAttribute("open")).not.toBeNull();
      expect(await gateway.getRequests("device.pair.rename")).toHaveLength(0);
    });
  });
});
