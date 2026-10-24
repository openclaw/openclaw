import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI update lifecycle E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const updateAvailable = {
  channel: "dev",
  commitsBehind: 246,
  currentSha: "1111111111111111111111111111111111111111",
  currentVersion: "2026.8.1",
  latestVersion: "2026.8.1",
  upstreamRef: "origin/main",
  upstreamSha: "9f3c21a0000000000000000000000000000000aa",
} as const;
const schedule = {
  autoEnabled: false,
  channel: "dev",
  install: { kind: "git" as const, git: { status: "behind" as const, commitsBehind: 246 } },
  target: {
    kind: "git" as const,
    commitsBehind: updateAvailable.commitsBehind,
    upstreamRef: updateAvailable.upstreamRef,
    upstreamSha: updateAvailable.upstreamSha,
  },
};

suite.define(() => {
  it("opens dev update confirmation from the identity menu without starting an update", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 720, width: 1280 },
      },
      async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "update.status": { activeRun: null, lastRun: null, updateAvailable, schedule },
          },
        });
        expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
        await gateway.waitForRequest("chat.startup");
        await gateway.waitForRequest("update.status");
        await gateway.emitGatewayEvent("update.available", { schedule, updateAvailable });
        await page.locator(".sidebar-identity-card").click();
        await page.locator('.sidebar-identity-menu [data-value="command:updates"]').click();
        await page.getByRole("button", { name: "Update Gateway…", exact: true }).click();
        await page
          .locator("openclaw-modal-dialog")
          .getByRole("button", { name: "Update and restart", exact: true })
          .waitFor();
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        expect(errors).toEqual([]);
      },
    );
  });
});
