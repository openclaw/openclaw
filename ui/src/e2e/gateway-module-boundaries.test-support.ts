import { describe, expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export function defineGatewayModuleBoundaryTests(
  suite: ReturnType<typeof createControlUiE2eSuite>,
  moduleRequest: (sourcePath: string) => RegExp,
) {
  describe("Gateway recovery while a module is unavailable", () => {
    it.each([390, 1280])(
      "keeps recovery available after a sidebar download failure at %ipx",
      async (width) => {
        await suite.withPage(
          {
            viewport: { width, height: 844 },
            colorScheme: "dark",
            locale: "en-US",
            serviceWorkers: "block",
          },
          async ({ page }) => {
            let blockedSidebarRequests = 0;
            await page.route(moduleRequest("ui/src/components/app-sidebar.ts"), async (route) => {
              blockedSidebarRequests += 1;
              await route.abort("failed");
            });
            const gateway = await installMockGateway(page, {
              // The sidebar module is deliberately unavailable, so no roster can render.
              awaitInitialRoster: false,
            });
            // Failed production imports trigger the one-shot document reload.
            // Finish that replacement before testing a later Gateway disconnect.
            await Promise.all([
              page.waitForEvent("framenavigated", {
                predicate: (frame) =>
                  frame === page.mainFrame() &&
                  new URL(frame.url()).searchParams.has("openclaw_mount_recovery"),
              }),
              page.goto(`${suite.server.baseUrl}new`),
            ]);
            await waitForControlUiGatewayReady(page);
            await page.locator(".new-session-page__message").waitFor({ state: "visible" });
            await expect.poll(() => blockedSidebarRequests).toBeGreaterThan(0);
            expect(await page.locator(".sidebar-identity-card").isVisible()).toBe(false);

            await gateway.setOnline(false);
            const connectionStatus = page.locator(".shell-connection-status");
            await connectionStatus
              .locator(".gateway-status__label")
              .getByText("Reconnecting…", { exact: true })
              .waitFor({ state: "visible" });
            const socketCount = await gateway.getSocketCount();
            await connectionStatus.getByRole("button", { name: /Retry now/ }).click();
            await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
            await gateway.setOnline(true);
            await waitForControlUiGatewayReady(page);
            await expect.poll(() => connectionStatus.count()).toBe(0);
          },
        );
      },
    );
  });
}
