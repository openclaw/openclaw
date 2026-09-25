import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiElementScreenshot } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  assertSessionSectionCountAlignment,
  installMockGateway,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";

const suite = createControlUiE2eSuite({ name: "Workboard sidebar layout" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it("preserves navigation widths and section counts after Workboard filters load", async () => {
    const context = await suite.newBrowserContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: "dark",
    });
    const page = await context.newPage();
    try {
      const artifactDir = captureProof ? createControlUiE2eArtifactDir("sidebar-workboard") : null;
      const sessions = ["infra", "infra", "fixes", ""].map<
        GatewaySessionRow & { updatedAt: number }
      >((category, index) => ({
        key: "agent:main:sidebar-layout-" + index,
        kind: "direct",
        label: "Sidebar layout session " + index,
        category: category || undefined,
        updatedAt: Date.now(),
        status: "done",
        hasActiveRun: false,
      }));
      sessions.push(
        {
          key: "agent:main:sidebar-running",
          kind: "direct",
          label: "Running coding session",
          updatedAt: Date.now(),
          status: "running",
          hasActiveRun: true,
          worktree: { id: "running", branch: "running", repoRoot: "/workspace/example" },
        },
        {
          key: "agent:main:sidebar-attention",
          kind: "direct",
          label: "Coding session needs attention",
          updatedAt: Date.now(),
          status: "failed",
          lastRunError: "Test run failed",
          agentStatus: {
            note: "Review required",
            attention: "key",
            expiresAt: Date.now() + 120_000,
          },
          worktree: { id: "attention", branch: "attention", repoRoot: "/workspace/example" },
        },
      );
      await installMockGateway(page, {
        ...workboardUi,
        sessions,
        sessionGroups: ["infra", "fixes"],
        methodResponses: {
          "sessions.list": {
            count: sessions.length,
            defaults: { contextTokens: null, model: null, modelProvider: null },
            path: "",
            sessions,
            ts: 1,
          },
        },
      });
      await page.goto(suite.server.baseUrl + "new?agent=main");
      const workboard = page.locator(".sidebar-zone-entry .nav-item", { hasText: "Workboard" });
      const widths = () =>
        page.locator(".sidebar-zone-entry:has(.nav-item)").evaluateAll((rows) =>
          rows.map((row) => {
            const link = row.querySelector(".nav-item")!;
            const menu = row.querySelector(".sidebar-reorder-trigger")!;
            const rowBox = row.getBoundingClientRect();
            const linkBox = link.getBoundingClientRect();
            const menuBox = menu.getBoundingClientRect();
            return {
              label: link.textContent?.trim(),
              width: linkBox.width,
              available: rowBox.width - menuBox.width,
              right: linkBox.right,
              menuLeft: menuBox.left,
            };
          }),
        );
      await workboard.waitFor();
      await expect
        .poll(async () => (await widths()).find((row) => row.label === "Workboard")?.width)
        .toBeGreaterThan(150);
      const initialWidths = await widths();
      expect(await page.locator(".sidebar-session-group-status:empty").count()).toBe(0);
      const capture = async (name: string) => {
        if (!artifactDir) {
          return;
        }
        const sidebar = page.locator(".sidebar");
        await writeFile(
          path.join(artifactDir, name + ".png"),
          await takeControlUiElementScreenshot(page, sidebar, [workboard]),
        );
      };
      await workboard.hover();
      await capture("before-workboard");
      await workboard.click();
      await page.locator(".workboard-filter-trigger").click();
      await page
        .locator(".workboard-filter-display")
        .getByRole("button", { name: "Compact", exact: true })
        .click();
      await page.keyboard.press("Escape");
      await page.locator(".nav-item--home").click();
      await workboard.hover();
      await capture("after-workboard");
      const finalWidths = await widths();
      expect(finalWidths.map((row) => row.label)).toEqual(initialWidths.map((row) => row.label));
      for (const row of finalWidths) {
        expect.soft(row.width, row.label).toBeCloseTo(row.available, 1);
        expect.soft(row.right, row.label).toBeLessThanOrEqual(row.menuLeft + 0.1);
      }
      await page.locator(".sidebar-brand__new-thread").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      expect.soft(await widths()).toEqual(finalWidths);
      await assertSessionSectionCountAlignment(page, [
        "category:infra",
        "category:fixes",
        "ungrouped",
        "work",
      ]);
      await page
        .locator('[data-session-section="category:infra"] .sidebar-recent-sessions__head')
        .hover();
      await capture("aligned-counts");
      const codingStatus = page.locator(
        '[data-session-section="work"] .sidebar-session-group-status',
      );
      await codingStatus.locator(".sidebar-session-group-running").waitFor();
      await codingStatus.locator(".sidebar-session-group-attention").waitFor();
      const indicators = await codingStatus.locator(":scope > span").evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          return { left: box.left, right: box.right, centerY: box.y + box.height / 2 };
        }),
      );
      expect(indicators).toHaveLength(3);
      for (const indicator of indicators) {
        expect(indicator.centerY).toBeCloseTo(indicators[0]!.centerY, 1);
      }
      const ordered = indicators.toSorted((left, right) => left.left - right.left);
      for (let index = 1; index < ordered.length; index++) {
        expect(ordered[index]!.left).toBeGreaterThanOrEqual(ordered[index - 1]!.right);
      }
      const codingToggle = page.locator(
        '[data-session-section="work"] .sidebar-session-group-toggle',
      );
      for (const indicator of ["running", "attention"]) {
        await codingStatus.locator(`.sidebar-session-group-${indicator}`).click();
        await expect.poll(() => codingToggle.getAttribute("aria-expanded")).toBe("true");
        await codingToggle.click();
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  }, 120_000);
});
