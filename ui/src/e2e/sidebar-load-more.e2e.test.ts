import { expect, it } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
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
        // Child lists share these cursors; keep their competing read ahead of the roster request.
        await gateway.deferNext("sessions.list", { offset: limit * 2, includeGlobal: true });
        await gateway.waitForRequest("sessions.list", {
          match: { offset: limit * 2, includeGlobal: false },
        });
      }
      await more.click();
      await gateway.waitForRequest("sessions.list", {
        match: { offset: limit, includeGlobal: true },
      });
      await gateway.waitForRequest("sessions.list", {
        match: { offset: limit * 2, includeGlobal: true },
      });
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
    });
  });

  it.each([
    ["none", true],
    ["category", false],
  ] as const)(
    "auto-loads at the sidebar end only in flat view (%s)",
    async (grouping, autoLoads) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const pageSize = 40;
        // The chat pane follows the mocked cursor too; only sidebar pages count here.
        const sidebarOlderPage = { offset: pageSize, source: "sidebar" };
        const rows = Array.from({ length: pageSize + 1 }, (_, index) =>
          sessionRow("agent:main:thread-" + index, "Conversation " + index, 1000 - index),
        );
        const gateway = await installMockGateway(page, {
          sessions: rows,
          sessionKey: rows[0]!.key,
          methodResponses: {
            "sessions.list": {
              cases: [
                {
                  match: { offset: pageSize },
                  response: sessionsListResponse(rows.slice(pageSize), {
                    offset: pageSize,
                    totalCount: rows.length,
                    hasMore: false,
                    nextOffset: null,
                  }),
                },
                {
                  response: sessionsListResponse(rows.slice(0, pageSize), {
                    offset: 0,
                    totalCount: rows.length,
                    hasMore: true,
                    nextOffset: pageSize,
                  }),
                },
              ],
            },
          },
        });
        await page.addInitScript((value) => {
          localStorage.setItem("openclaw:sidebar:sessions:grouping", value);
        }, grouping);
        await page.setViewportSize({ width: 1280, height: 600 });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, rows[0]!.key));
        const sidebar = page.locator("openclaw-app-sidebar");
        const more = sidebar.getByRole("button", { name: "Load more sessions", exact: true });
        await more.waitFor();
        const olderPageRequests = () => gateway.getRequests("sessions.list", sidebarOlderPage);
        expect(await olderPageRequests()).toEqual([]);

        await more.scrollIntoViewIfNeeded();
        if (autoLoads) {
          await gateway.waitForRequest("sessions.list", { match: sidebarOlderPage });
          await more.waitFor({ state: "detached" });
          return;
        }
        // Let the observer deliver before proving grouped views stay manual.
        await page.evaluate(
          () =>
            new Promise((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(resolve));
            }),
        );
        expect(await olderPageRequests()).toEqual([]);
        await more.click();
        await gateway.waitForRequest("sessions.list", { match: sidebarOlderPage });
      });
    },
  );
});
