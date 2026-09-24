import path from "node:path";
import { expect, it } from "vitest";
import type { UpdateScheduleState } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Git update revisions",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it.each([1280, 420])(
    "shows the Git revision range before updating at width %s",
    async (width) => {
      const proofDir = createControlUiE2eArtifactDir("update-git-revisions");
      await suite.withPage(
        {
          colorScheme: "dark",
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width, height: 900 },
        },
        async ({ page }) => {
          const updateAvailable = {
            channel: "dev",
            currentVersion: "2026.9.5",
            latestVersion: "2026.9.5",
            currentSha: "1234567890abcdef1234567890abcdef12345678",
            upstreamSha: "abcdef1234567890abcdef1234567890abcdef12",
            upstreamRef: "origin/main",
            repositoryUrl: "https://github.com/example/openclaw",
            commitsBehind: 3,
          };
          const schedule: UpdateScheduleState = {
            channel: "dev",
            autoEnabled: false,
            install: {
              kind: "git",
              git: { status: "behind", currentSha: updateAvailable.currentSha, commitsBehind: 3 },
            },
            target: {
              kind: "git",
              upstreamRef: "origin/main",
              upstreamSha: updateAvailable.upstreamSha,
              commitsBehind: 3,
            },
          };
          const gateway = await installMockGateway(page, {
            updateAvailable,
            updateSchedule: schedule,
            methodResponses: {
              "update.status": { sentinel: null, schedule, updateAvailable },
            },
          });
          expect((await page.goto(`${suite.server.baseUrl}settings/updates`))?.status()).toBe(200);
          await waitForControlUiRoute(page, { pathname: "/settings/updates", routeId: "updates" });
          await page.getByRole("button", { name: "Update now", exact: true }).click();
          await page.getByRole("dialog", { name: "Update Gateway", exact: true }).waitFor();
          const modal = page.locator("openclaw-modal-dialog");
          await page.screenshot({
            animations: "disabled",
            path: path.join(proofDir, `confirmation-${width}.png`),
          });
          const summary = modal.locator(".exec-approval-command > div").first();
          const range = modal.locator(".update-git-revisions__range");
          expect(await summary.textContent()).toBe("Installed v2026.9.5 · 3 commits behind");
          expect(await range.locator("code").allTextContents()).toEqual(["12345678", "abcdef12"]);
          const summaryBox = await summary.boundingBox();
          const rangeBox = await range.boundingBox();
          expect(rangeBox?.y).toBeGreaterThan((summaryBox?.y ?? 0) + (summaryBox?.height ?? 0));
          expect(
            (rangeBox?.y ?? 0) - (summaryBox?.y ?? 0) - (summaryBox?.height ?? 0),
          ).toBeLessThan(30);
          const codeBoxes = await range
            .locator("code")
            .evaluateAll((codes) => codes.map((code) => code.getBoundingClientRect().top));
          expect(codeBoxes[0]).toBe(codeBoxes[1]);
          const link = modal.getByRole("link", { name: "Compare on GitHub" });
          expect(await link.getAttribute("href")).toBe(
            `https://github.com/example/openclaw/compare/${updateAvailable.currentSha}...${updateAvailable.upstreamSha}`,
          );
          expect(await link.getAttribute("target")).toBe("_blank");
          expect(await gateway.getRequests("update.run")).toHaveLength(0);
          await page.getByRole("button", { name: "Cancel", exact: true }).click();
          await modal.waitFor({ state: "detached" });
          expect(await page.locator(".settings-status").textContent()).toContain(
            "3 commits behind",
          );
          expect(
            await page
              .locator(".updates-status-control .update-git-revisions code")
              .allTextContents(),
          ).toEqual(["12345678", "abcdef12"]);
        },
      );
    },
  );
});
