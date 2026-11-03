import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Git update revisions",
  startServerBeforeBrowser: true,
});
const updateAvailable = {
  channel: "dev",
  currentVersion: "2026.9.5",
  latestVersion: "2026.9.5",
  currentSha: "a".repeat(40),
  repositoryUrl: "https://github.com/example/openclaw",
};
const schedule = {
  channel: "dev",
  autoEnabled: false,
  install: {
    kind: "git",
    git: { status: "behind", ...updateAvailable, upstreamSha: "c".repeat(40), commitsBehind: 5 },
  },
};

suite.define(() => {
  it.each([1280, 420])("shows the Git revision range before updating at width %s", (width) =>
    suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width, height: 900 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          updateAvailable,
          methodResponses: { "update.status": { sentinel: null, schedule, updateAvailable } },
        });
        await page.goto(`${suite.server.baseUrl}settings/updates`);
        await waitForControlUiRoute(page, { pathname: "/settings/updates", routeId: "updates" });
        await page.locator(".settings-status", { hasText: "5 commits behind" }).waitFor();
        await page.getByRole("button", { name: "Update Gateway…", exact: true }).click();
        await page.getByRole("dialog", { name: "Update Gateway", exact: true }).waitFor();
        const modal = page.locator("openclaw-modal-dialog");
        const summary = modal.locator(".exec-approval-command > div").first();
        const range = modal.locator(".update-git-revisions__range");
        expect(await range.locator("code").allTextContents()).toEqual(["aaaaaaaa", "cccccccc"]);
        const summaryBox = await summary.boundingBox();
        const rangeBox = await range.boundingBox();
        expect(rangeBox?.y).toBeGreaterThan((summaryBox?.y ?? 0) + (summaryBox?.height ?? 0));
        expect((rangeBox?.y ?? 0) - (summaryBox?.y ?? 0) - (summaryBox?.height ?? 0)).toBeLessThan(
          30,
        );
        const codeBoxes = await range
          .locator("code")
          .evaluateAll((codes) => codes.map((code) => code.getBoundingClientRect().top));
        expect(codeBoxes[0]).toBe(codeBoxes[1]);
        const link = modal.getByRole("link", { name: "Compare on GitHub" });
        expect(await link.getAttribute("target")).toBe("_blank");
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
      },
    ),
  );
});
