import { expect, it, vi } from "vitest";
import {
  LOCAL_GIT_WORKSPACE_RESPONSES,
  createNewSessionPageE2eSuite,
  installMockGateway,
  openEnvironmentPicker,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

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
        const picker = page.locator(".oc-popover.new-session-page__where-popover");
        const loading = picker.locator(".new-session-page__environment-skeletons");
        await loading.first().waitFor();
        expect(await loading.count()).toBe(2);
        expect(await loading.first().getAttribute("aria-busy")).toBe("true");
        const skeletonWidths = await picker
          .locator(".new-session-page__environment-skeleton-row")
          .evaluateAll((rows) => rows.map((row) => Math.round(row.getBoundingClientRect().width)));
        expect(new Set(skeletonWidths).size).toBe(1);

        await gateway.resolveDeferred("environments.list", {
          environments: [],
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
        await plus.waitFor({ state: "visible" });
        await chevron.waitFor({ state: "visible" });
        await vi.waitFor(async () => {
          const [plusBox, chevronBox] = await Promise.all([
            plus.boundingBox(),
            chevron.boundingBox(),
          ]);
          expect(plusBox).not.toBeNull();
          expect(plusBox?.width).toBeLessThanOrEqual(20);
          expect(chevronBox).not.toBeNull();
          const center = (box: typeof plusBox) => (box?.x ?? 0) + (box?.width ?? 0) / 2;
          expect(Math.abs(center(plusBox) - center(chevronBox))).toBeLessThanOrEqual(4);
        });
      },
    );
  });
});
