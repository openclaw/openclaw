import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import {
  createCronJob,
  createCronRunsResult,
  cronJobsListResponse,
  cronListResponseFixture,
} from "../test-helpers/cron.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { cronSidebarFeatureMethods } from "./cron-fixtures.test-support.ts";
import { openSidebarPages } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mobile web sidebar section navigation" });
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const phone = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  colorScheme: "dark",
  reducedMotion: "reduce",
  locale: "en-US",
} as const;

suite.define(() => {
  it.each([false, true])(
    "keeps Automations open until a destination is chosen (has job: %s)",
    (hasJob) =>
      suite.withPage(phone, async ({ page }) => {
        const job = createCronJob("report", "Weekly report");
        await installMockGateway(page, {
          featureMethods: [...cronSidebarFeatureMethods, "cron.get", "cron.runs", "cron.status"],
          methodResponses: {
            "cron.list": cronListResponseFixture(cronJobsListResponse(hasJob ? [job] : [])),
            "cron.get": job,
            "cron.runs": createCronRunsResult([]),
            "cron.status": { enabled: true, jobs: hasJob ? 1 : 0, nextWakeAtMs: null },
          },
        });
        await seedChatSettings(page, suite.server.baseUrl, { railShortcuts: ["route:cron"] });
        await page.goto(suite.server.baseUrl + "chat");
        const toggle = navigationDrawerToggle(page);
        await toggle.tap();
        const rail = page.locator(".sidebar-rail");
        await rail.getByRole("link", { name: "Automations", exact: true }).tap();
        await waitForControlUiRoute(page, { routeId: "cron", pathname: "/automations" });
        const shell = page.locator(".shell");
        const list = page.locator(".sidebar-automations");
        const create = list.getByRole("link", { name: "New automation", exact: true });
        if (capture && !hasJob) {
          const open = (await toggle.getAttribute("aria-expanded")) === "true";
          await writeFile(
            path.join(suite.artifactDir, open ? "after.png" : "before.png"),
            await takeControlUiViewportScreenshot(page, shell, [open ? create : toggle]),
          );
        }
        expect(await toggle.getAttribute("aria-expanded")).toBe("true");
        expect(await page.locator(".cron-page--create").count()).toBe(0);
        if (hasJob) {
          await list.getByRole("link", { name: /Weekly report/ }).tap();
          await waitForControlUiRoute(page, { routeId: "cron", search: "?job=report" });
          await page.locator(".cron-detail-title", { hasText: "Weekly report" }).waitFor();
        } else {
          await create.tap();
          await page.locator(".cron-page--create").waitFor();
        }
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      }),
  );

  it("opens Customize, Systems and Workboard lists from Pages without closing the drawer", () =>
    suite.withPage(phone, async ({ page }) => {
      const boards = [
        { id: "ops", name: "Operations", total: 0, active: 0, archived: 0, byStatus: {} },
      ];
      await installNativePluginMockGateway(page, {
        ...workboardUi,
        methodResponses: {
          "workboard.boards.list": { boards },
          "workboard.cards.list": { boards, cards: [], statuses: ["todo", "done"] },
          "backup.status": { targets: [], schedules: [], locations: [] },
          "environments.list": {
            environments: [
              { id: "gateway", type: "local", label: "Gateway machine", status: "available" },
              { id: "worker", type: "worker", label: "Cloud worker", status: "available" },
            ],
          },
        },
      });
      await page.goto(suite.server.baseUrl + "chat");
      const toggle = navigationDrawerToggle(page);
      await toggle.tap();
      await (
        await openSidebarPages(page)
      )
        .getByRole("link", { name: "Customize", exact: true })
        .tap();
      await waitForControlUiRoute(page, { routeId: "plugins" });
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      await page
        .locator(".sidebar-customize")
        .getByRole("link", { name: "Skills", exact: true })
        .tap();
      await waitForControlUiRoute(page, { routeId: "skills" });
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");

      await toggle.tap();
      await (
        await openSidebarPages(page)
      )
        .getByRole("link", { name: "Systems", exact: true })
        .tap();
      await waitForControlUiRoute(page, { routeId: "systems" });
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      const worker = page.locator(".systems-sidebar").getByRole("button", { name: /Cloud worker/ });
      await worker.tap();
      await expect.poll(() => worker.getAttribute("aria-pressed")).toBe("true");

      await (
        await openSidebarPages(page)
      )
        .getByRole("link", { name: "Workboard", exact: true })
        .tap();
      await waitForControlUiRoute(page, { routeId: "workboard", pathname: "/workboard" });
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      await page.locator(".sidebar-plugin-section").getByRole("link", { name: "Operations" }).tap();
      await waitForControlUiRoute(page, { routeId: "workboard", pathname: "/workboard/ops" });
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      await page.keyboard.press("Escape");
      await page.locator(".workboard-page-title", { hasText: "Operations" }).waitFor();
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      await expect
        .poll(() => toggle.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await toggle.tap();
      await (await openSidebarPages(page)).getByRole("link", { name: "Usage", exact: true }).tap();
      await waitForControlUiRoute(page, { routeId: "usage" });
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    }));
});
