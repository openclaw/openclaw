import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  controlUiSessionUrl,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
suite.define(() => {
  it.each([false, true])("gets past hidden-only pages (retry=%s)", async (retry) => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const limit = SIDEBAR_SESSION_ROSTER_LIMIT;
      const rows = Array.from({ length: limit * 2 + 1 }, (_, index) =>
        sessionRow(
          index >= 7 && index < limit * 2
            ? "agent:main:cron:hidden-" + index
            : "agent:main:thread-" + index,
          "Conversation " + index,
          1000 - index,
        ),
      );
      const response = (offset: number) =>
        sessionsListResponse(rows.slice(offset, offset + limit), {
          offset,
          totalCount: rows.length,
          hasMore: offset + limit < rows.length,
          nextOffset: offset + limit < rows.length ? offset + limit : null,
        });
      const gateway = await installMockGateway(page, {
        sessions: rows,
        sessionKey: rows[0]!.key,
        methodResponses: {
          "sessions.list": {
            cases: [
              { match: { offset: limit * 2 }, response: response(limit * 2) },
              { match: { offset: limit }, response: response(limit) },
              { response: response(0) },
            ],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, rows[0]!.key));
      const sidebar = page.locator("openclaw-app-sidebar");
      const more = sidebar.getByRole("button", { name: "Load more sessions", exact: true });
      if (retry) {
        await gateway.deferNext("sessions.list", { offset: limit * 2 });
      }
      await more.click();
      await gateway.waitForRequest("sessions.list", { match: { offset: limit } });
      await gateway.waitForRequest("sessions.list", { match: { offset: limit * 2 } });
      if (retry) {
        await gateway.resolveDeferred("sessions.list", {
          __mockError: { code: "UNAVAILABLE", message: "Older sessions temporarily unavailable" },
        });
        await sidebar
          .getByText("Older sessions temporarily unavailable", { exact: false })
          .waitFor();
        expect(await sidebar.locator(".sidebar-recent-session").count()).toBe(7);
        await more.click();
      }
      await sidebar.locator('[data-session-key="agent:main:thread-' + limit * 2 + '"]').waitFor();
      expect(await more.count()).toBe(0);
      expect(await sidebar.locator(".sidebar-recent-session").count()).toBe(8);
      if (!retry && process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const frame = await takeControlUiScreenshotFrame(
          page,
          sidebar.locator(".sidebar"),
          [sidebar.getByText("Conversation " + limit * 2, { exact: true })],
          { elements: [sidebar.locator(".sidebar")], animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "after.png"), frame.elements[0]!.png);
      }
    });
  });
});
