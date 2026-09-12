import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  LOCAL_GIT_WORKSPACE_RESPONSES,
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
  openEnvironmentPicker,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

async function takeScreenshot(page: Parameters<typeof openEnvironmentPicker>[0]) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return page.screenshot({ animations: "disabled", scale: "css" });
}

suite.define(() => {
  it("shows catalog skeletons, then uses provider capabilities and fallback defaults", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
          workspaceGit: true,
          heldMethods: ["environments.list"],
          methodResponses: LOCAL_GIT_WORKSPACE_RESPONSES,
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("environments.list");
        await openEnvironmentPicker(page);
        const picker = page.locator("wa-popover.new-session-page__where-popover");
        const loading = picker.locator(".new-session-page__environment-skeletons");
        await loading.first().waitFor();
        expect(await loading.count()).toBe(2);
        expect(await loading.first().getAttribute("aria-busy")).toBe("true");
        if (captureUiProofEnabled) {
          await writeFile(
            path.join(suite.artifactDir, "environment-picker-loading-after.png"),
            await takeScreenshot(page),
          );
        }

        await gateway.resolveDeferred("environments.list", {
          environments: [
            {
              id: "node:studio",
              type: "node",
              label: "Studio Mac",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 2, available: 2 },
            },
          ],
          profiles: [
            {
              id: "Daytona Crabbox",
              providerId: "crabbox",
              machines: [
                { id: "small", label: "Small", cpu: 4, memoryGb: 8 },
                { id: "large", label: "Large", cpu: 8, memoryGb: 16 },
              ],
            },
            { id: "GCP", providerId: "crabbox" },
            { id: "Machine0", providerId: "crabbox" },
          ],
        });
        const daytona = picker.getByRole("button", { name: "Daytona Crabbox", exact: true });
        await daytona.waitFor();
        await daytona.hover();
        const configuration = picker.locator(".new-session-page__cloud-configuration");
        await configuration.waitFor();
        expect(await configuration.getByText("Operating system", { exact: true }).count()).toBe(0);
        await configuration.getByText("Machine", { exact: true }).waitFor();
        expect(
          await configuration.locator('[data-value="machine:small"]').getAttribute("aria-pressed"),
        ).toBe("true");
        expect(await picker.locator(".new-session-page__cloud-configuration").count()).toBe(1);
        const plus = picker.locator('[data-action="manage-cloud-workers"]');
        const chevron = daytona.locator(".new-session-page__submenu-chevron");
        const [plusBox, chevronBox] = await Promise.all([
          plus.boundingBox(),
          chevron.boundingBox(),
        ]);
        expect(plusBox?.width).toBeLessThanOrEqual(20);
        expect(chevronBox).not.toBeNull();
        expect(
          Math.abs(
            (plusBox?.x ?? 0) +
              (plusBox?.width ?? 0) / 2 -
              ((chevronBox?.x ?? 0) + (chevronBox?.width ?? 0) / 2),
          ),
        ).toBeLessThanOrEqual(4);
        if (captureUiProofEnabled) {
          await writeFile(
            path.join(suite.artifactDir, "environment-picker-capabilities-after.png"),
            await takeScreenshot(page),
          );
        }
      },
    );
  });
});
