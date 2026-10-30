import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI stale Git update refresh proof",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const updateAvailable = {
  channel: "dev",
  commitsBehind: 12,
  currentSha: "1".repeat(40),
  currentVersion: "2026.9.3",
  latestVersion: "2026.9.3",
  upstreamRef: "origin/main",
  upstreamSha: "2".repeat(40),
} as const;
const staleSchedule = {
  channel: "dev",
  autoEnabled: false,
  install: { kind: "git", git: { status: "behind", commitsBehind: 12 } },
  target: {
    kind: "git",
    commitsBehind: 12,
    upstreamRef: "origin/main",
    upstreamSha: "2".repeat(40),
  },
} as const;
const currentSchedule = {
  ...staleSchedule,
  install: { kind: "git", git: { status: "current" } },
} as const;
suite.define(() => {
  it("retires stale update prompts after a completed checkout refresh", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "update.status": { sentinel: null, schedule: staleSchedule, updateAvailable },
          },
          operatorScopes: ["operator.read", "operator.admin"],
          updateAvailable,
          updateSchedule: staleSchedule,
        });
        expect((await page.goto(`${suite.server.baseUrl}settings/appearance`))?.status()).toBe(200);
        await waitForControlUiRoute(page, {
          pathname: "/settings/appearance",
          routeId: "appearance",
        });
        await gateway.deferNext("update.status");
        await page.locator('a[href="/settings/updates"]').click();
        await waitForControlUiRoute(page, { pathname: "/settings/updates", routeId: "updates" });
        await gateway.waitForRequest("update.status");
        const staleStatus = page.locator(".settings-status", { hasText: "12 commits behind" });
        await page.locator(".settings-status", { hasText: "Checking for updates…" }).waitFor();
        expect(
          await gateway.getRequests("update.status", { refreshCheckout: true }),
        ).not.toHaveLength(0);
        const refreshedStatus = { sentinel: null, schedule: currentSchedule, updateAvailable };
        await gateway.setMethodResponse("update.status", refreshedStatus);
        await gateway.resolveDeferred("update.status", refreshedStatus);
        await page.getByText("Up to date", { exact: true }).waitFor();
        await page
          .locator(".settings-status", { hasText: "Checking for updates…" })
          .waitFor({ state: "hidden" });
        expect(await staleStatus.count()).toBe(0);
      },
    );
  });
});
