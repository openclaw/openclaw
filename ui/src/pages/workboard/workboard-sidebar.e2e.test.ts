import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { openSidebarPages } from "../../e2e/sidebar-customization.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";
import type { ControlUiSessionFixture } from "../../test-helpers/control-ui-session-fixtures.ts";
import { assertSessionSectionCountAlignment } from "../../test-helpers/control-ui-session-section-layout.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";
import { button, createWorkboardProof } from "./workboard.e2e.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Workboard sidebar layout" });

function session(id: string, overrides: Partial<ControlUiSessionFixture> = {}) {
  return {
    key: `agent:main:sidebar-${id}`,
    kind: "direct",
    updatedAt: Date.now(),
    ...overrides,
  };
}

suite.define(() => {
  it("preserves navigation widths and section counts after Workboard filters load", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1000 }, colorScheme: "dark" },
      async ({ page }) => {
        const proof = createWorkboardProof(suite, "sidebar-workboard", undefined, {
          captureMode: "element",
        });
        const sessions = ["infra", "infra", "fixes", ""].map((category, index) =>
          session(`layout-${index}`, {
            category: category || undefined,
            status: "done",
            hasActiveRun: false,
          }),
        );
        sessions.push(
          session("running", {
            status: "running",
            hasActiveRun: true,
            worktree: { id: "running", branch: "running", repoRoot: "/workspace/example" },
          }),
          session("attention", {
            status: "failed",
            lastRunError: "Test run failed",
            agentStatus: {
              note: "Review required",
              attention: "key",
              expiresAt: Date.now() + 120_000,
            },
            worktree: { id: "attention", branch: "attention", repoRoot: "/workspace/example" },
          }),
        );
        await installMockGateway(page, {
          ...workboardUi,
          sessions,
          sessionGroups: ["infra", "fixes"],
        });
        await page.goto(suite.server.baseUrl + "new?agent=main");
        const sidebar = page.locator("openclaw-app-sidebar");
        await openSidebarPages(page);
        const workboardEntry = sidebar.locator(".sidebar-pages__entry").filter({
          has: page.locator('[data-sidebar-entry="plugin:workboard/workboard"]'),
        });
        await button(workboardEntry, "Pin").click();
        const rail = sidebar.locator(".sidebar-rail__pins");
        const workboard = rail.getByRole("link", { name: "Workboard", exact: true });
        const widths = () =>
          rail.locator(".sidebar-rail__pin:has(.nav-item)").evaluateAll((rows) =>
            rows.map((row) => {
              const link = row.querySelector(".nav-item")!;
              const icon = link.querySelector(".nav-item__icon")!;
              const rowBox = row.getBoundingClientRect();
              const linkBox = link.getBoundingClientRect();
              const iconBox = icon.getBoundingClientRect();
              return {
                label: link.textContent?.trim(),
                width: linkBox.width,
                available: rowBox.width,
                height: linkBox.height,
                iconContained:
                  iconBox.left >= linkBox.left &&
                  iconBox.right <= linkBox.right &&
                  iconBox.top >= linkBox.top &&
                  iconBox.bottom <= linkBox.bottom,
                iconCenter: iconBox.left + iconBox.width / 2 - linkBox.left,
                labelWidth: link.querySelector(".nav-item__text")!.getBoundingClientRect().width,
              };
            }),
          );
        await workboard.waitFor();
        expect(await rail.locator(".sidebar-reorder-trigger").count()).toBe(0);
        await expect
          .poll(async () => (await widths()).find((row) => row.label === "Workboard")?.width)
          .toBeCloseTo(36, 1);
        await button(sidebar, "Sessions").click();
        const initialWidths = await widths();
        expect(await page.locator(".sidebar-session-group-status:empty").count()).toBe(0);
        const capture = (name: string) =>
          proof.capture(page, name, page.locator(".sidebar"), [workboard]);
        await workboard.hover();
        await capture("before-workboard");
        await workboard.click();
        await page.locator(".workboard-filter-trigger").click();
        await button(page.locator(".workboard-filter-display"), "Compact").click();
        await page.keyboard.press("Escape");
        await button(sidebar, "Talk to your Home agent").click();
        await button(page, "Open Home full page").click();
        await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/chat(?:\/|$)/u);
        await workboard.hover();
        await capture("after-workboard");
        const finalWidths = await widths();
        expect(finalWidths.map((row) => row.label)).toEqual(initialWidths.map((row) => row.label));
        for (const row of finalWidths) {
          expect.soft(row, row.label).toMatchObject({
            width: expect.closeTo(row.available, 1),
            iconContained: true,
            height: expect.closeTo(36, 1),
            iconCenter: expect.closeTo(row.width / 2, 1),
          });
          expect.soft(row.labelWidth, row.label).toBeLessThanOrEqual(1);
        }
        const newConversation = sidebar.getByRole("link", {
          name: "New conversation",
          exact: true,
        });
        if (!(await sidebar.locator(".sidebar-session-toolbar").isVisible())) {
          await button(sidebar, "Sessions").click();
        }
        await newConversation.click();
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
        const codingSection = page.locator('[data-session-section="work"]');
        const codingStatus = codingSection.locator(".sidebar-session-group-status");
        await codingStatus.locator(".sidebar-session-group-running").waitFor();
        await codingStatus.locator(".sidebar-session-group-attention").waitFor();
        const indicators = await codingStatus.locator(":scope > span").evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            return { left: box.left, right: box.right, centerY: box.y + box.height / 2 };
          }),
        );
        const centerY = expect.closeTo(indicators[0]!.centerY, 1);
        expect(indicators).toMatchObject([{ centerY }, { centerY }, { centerY }]);
        const ordered = indicators.toSorted((left, right) => left.left - right.left);
        for (let index = 1; index < ordered.length; index++) {
          expect(ordered[index]!.left).toBeGreaterThanOrEqual(ordered[index - 1]!.right);
        }
        const codingToggle = codingSection.locator(".sidebar-session-group-toggle");
        for (const indicator of ["running", "attention"]) {
          await codingStatus.locator(`.sidebar-session-group-${indicator}`).click();
          await expect.poll(() => codingToggle.getAttribute("aria-expanded")).toBe("true");
          await codingToggle.click();
        }
      },
    );
  }, 120_000);
});
