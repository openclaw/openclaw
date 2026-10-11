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
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.getByRole("button", { name: "Pages", exact: true }).click();
      const workboardEntry = sidebar.locator(".sidebar-pages__entry").filter({
        has: page.locator('[data-sidebar-entry="plugin:workboard/workboard"]'),
      });
      await workboardEntry.getByRole("button", { name: "Pin", exact: true }).click();
      const rail = sidebar.locator(".sidebar-rail__pins");
      const workboard = rail.getByRole("link", { name: "Workboard", exact: true });
      const widths = () =>
        rail.locator(".sidebar-rail__pin:has(.nav-item)").evaluateAll((rows) =>
          rows.map((row) => {
            const link = row.querySelector(".nav-item")!;
            const icon = link.querySelector(".nav-item__icon")!;
            const menu = row.querySelector(".sidebar-reorder-trigger")!;
            const rowBox = row.getBoundingClientRect();
            const linkBox = link.getBoundingClientRect();
            const menuBox = menu.getBoundingClientRect();
            const menuIconBox = menu.querySelector("svg")!.getBoundingClientRect();
            const iconBox = icon.getBoundingClientRect();
            return {
              label: link.textContent?.trim(),
              width: linkBox.width,
              available: rowBox.width,
              height: linkBox.height,
              gripStart: menuBox.left - rowBox.left,
              gripEnd: menuBox.right - rowBox.left,
              gripTop: menuBox.top - rowBox.top,
              gripBottom: menuBox.bottom - rowBox.top,
              gripWidth: menuBox.width,
              gripHeight: menuBox.height,
              rowHeight: rowBox.height,
              railEnd: row.closest(".sidebar-rail")!.getBoundingClientRect().right - rowBox.left,
              gripIconContained:
                menuIconBox.left >= menuBox.left &&
                menuIconBox.right <= menuBox.right &&
                menuIconBox.top >= menuBox.top &&
                menuIconBox.bottom <= menuBox.bottom,
              glyphClearOfGrip:
                menuBox.left >= iconBox.right ||
                menuBox.right <= iconBox.left ||
                menuBox.top >= iconBox.bottom ||
                menuBox.bottom <= iconBox.top,
              iconCenter: iconBox.left + iconBox.width / 2 - linkBox.left,
              labelWidth: link.querySelector(".nav-item__text")!.getBoundingClientRect().width,
            };
          }),
        );
      await workboard.waitFor();
      await expect
        .poll(async () => (await widths()).find((row) => row.label === "Workboard")?.width)
        .toBeCloseTo(36, 1);
      await sidebar.getByRole("button", { name: "Sessions", exact: true }).click();
      const initialWidths = await widths();
      expect(await page.locator(".sidebar-session-group-status:empty").count()).toBe(0);
      const capture = async (name: string) => {
        if (!artifactDir) {
          return;
        }
        const surface = page.locator(".sidebar");
        await writeFile(
          path.join(artifactDir, name + ".png"),
          await takeControlUiElementScreenshot(page, surface, [workboard]),
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
      await sidebar.getByRole("button", { name: "Talk to your Home agent", exact: true }).click();
      await page.getByRole("button", { name: "Open Home full page", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/chat(?:\/|$)/u);
      await workboard.hover();
      await capture("after-workboard");
      const finalWidths = await widths();
      expect(finalWidths.map((row) => row.label)).toEqual(initialWidths.map((row) => row.label));
      for (const row of finalWidths) {
        expect.soft(row.width, row.label).toBeCloseTo(row.available, 1);
        expect.soft(row.gripStart, row.label).toBeGreaterThanOrEqual(-0.1);
        expect.soft(row.gripEnd, row.label).toBeLessThanOrEqual(row.available);
        expect.soft(row.gripEnd, row.label).toBeLessThanOrEqual(row.railEnd);
        expect.soft(row.gripTop, row.label).toBeGreaterThanOrEqual(0);
        expect.soft(row.gripBottom, row.label).toBeLessThanOrEqual(row.rowHeight);
        expect.soft(row.gripWidth, row.label).toBeGreaterThanOrEqual(24);
        expect.soft(row.gripHeight, row.label).toBeGreaterThanOrEqual(24);
        expect.soft(row.gripIconContained, row.label).toBe(true);
        // Either axis may separate a stacked or adjacent control from its glyph.
        expect.soft(row.glyphClearOfGrip, row.label).toBe(true);
        expect.soft(row.height, row.label).toBeCloseTo(36, 1);
        expect.soft(row.iconCenter, row.label).toBeCloseTo(row.width / 2, 1);
        expect.soft(row.labelWidth, row.label).toBeLessThanOrEqual(1);
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
