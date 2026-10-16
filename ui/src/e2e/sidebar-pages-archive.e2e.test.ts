import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";
import { openSidebarPages } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Pages archive filtering" });

suite.define(() => {
  it("omits archived dashboards from Pages initially and when loading more", async () => {
    const context = await suite.newBrowserContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const active = sessionRow("agent:main:release", "Release dashboard", 3, { hasBoard: true });
    const next = sessionRow("agent:main:planning", "Planning board", 2, { hasBoard: true });
    const archived = sessionRow("agent:main:archived", "Archived launch notes", 1, {
      hasBoard: true,
      archived: true,
    });
    const gateway = await installMockGateway(page, {
      sessionArchiveFiltering: true,
      sessions: [active, next, archived],
      methodResponses: {
        "sessions.list": {
          cases: [
            {
              match: { hasBoard: true, archived: "all" },
              response: sessionsListResponse([active, archived]),
            },
            { match: { hasBoard: true, offset: 1 }, response: sessionsListResponse([next]) },
            {
              match: { hasBoard: true },
              response: { ...sessionsListResponse([active]), hasMore: true, nextOffset: 1 },
            },
            { match: {}, response: sessionsListResponse([active, next]) },
          ],
        },
      },
    });
    try {
      await page.goto(suite.server.baseUrl + "chat");
      const pages = await openSidebarPages(page);
      const row = (key: string) => pages.locator('[data-session-key="' + key + '"]');
      await row(active.key).waitFor();
      expect(await row(archived.key).count()).toBe(0);
      expect(await pages.locator(".sidebar-session-sort").count()).toBe(0);
      await pages.getByRole("button", { name: "Show more", exact: true }).click();
      await row(next.key).waitFor();
      const request = await gateway.waitForRequest("sessions.list", {
        match: { hasBoard: true, offset: 1 },
      });
      expect(request.params).not.toHaveProperty("archived");
      expect(await row(archived.key).count()).toBe(0);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        await page.mouse.move(15, 850);
        const frame = await takeControlUiScreenshotFrame(
          page,
          pages,
          [row(active.key), row(next.key)],
          {
            elements: [page.locator("aside.sidebar")],
            animations: "disabled",
          },
        );
        await writeFile(
          path.join(suite.artifactDir, "pages-active-only.png"),
          frame.elements[0]!.png,
        );
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
