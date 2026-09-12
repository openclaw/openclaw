import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
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
    const proofDir = createControlUiE2eArtifactDir("update-stale-git-refresh");
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "update.status": {
              sentinel: null,
              schedule: staleSchedule,
              updateAvailable,
            },
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
        await waitForControlUiRoute(page, {
          pathname: "/settings/updates",
          routeId: "updates",
        });
        await gateway.waitForRequest("update.status");
        const staleStatus = page.locator(".settings-status", { hasText: "12 commits behind" });
        await staleStatus.waitFor();
        await page.screenshot({
          animations: "disabled",
          path: path.join(proofDir, "01-stale-update-status.png"),
        });
        const refreshRequest = (await gateway.getRequests("update.status")).at(-1);
        const refreshCheckoutRequested =
          typeof refreshRequest?.params === "object" &&
          refreshRequest.params !== null &&
          "refreshCheckout" in refreshRequest.params &&
          refreshRequest.params.refreshCheckout === true;
        expect(refreshCheckoutRequested).toBe(true);
        await gateway.resolveDeferred("update.status", {
          sentinel: null,
          schedule: currentSchedule,
          updateAvailable,
        });
        await page.getByText("Up to date", { exact: true }).waitFor();
        expect(await staleStatus.count()).toBe(0);
        await page.screenshot({
          animations: "disabled",
          path: path.join(proofDir, "02-current-after-refresh.png"),
        });

        console.info("stale Git update refresh proof", {
          refreshCheckoutRequested,
          refreshedStatus: currentSchedule.install.git.status,
          staleTargetRetainedByGateway: currentSchedule.target.commitsBehind === 12,
          staleAvailabilityTextCount: await staleStatus.count(),
        });
      },
    );
  });
});
